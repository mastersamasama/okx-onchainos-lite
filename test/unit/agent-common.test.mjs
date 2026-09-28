// Unit tests for the agent-commerce foundation (lib/agent/** owned by A0). Oracles: the upstream
// Rust unit tests of agent_commerce/{mod.rs, task/arbitration.rs, task/common/{state_machine,
// template_vars,user_lang,deadline,util,mod,pending_v2,deliverables,review_gate,funding_notice}.rs}
// plus golden output captured from the upstream binary (funding-notice success render, whose
// pid+nanos PNG name cannot be masked line-wise by the parity runner).
// Never spawns okx-a2a for real: PATH is pointed at an empty directory before any queue-mode call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-agent-common-'));
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
const NOBIN = join(HOME, 'nobin');
mkdirSync(NOBIN, { recursive: true });
after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const LIB = '../../skill/onchainos-lite/lib/agent/';
const sm = await import(`${LIB}task/common/state-machine.mjs`);
const tv = await import(`${LIB}task/common/template-vars.mjs`);
const lang = await import(`${LIB}task/common/user-lang.mjs`);
const dl = await import(`${LIB}task/common/deadline.mjs`);
const util = await import(`${LIB}task/common/util.mjs`);
const root = await import(`${LIB}index.mjs`);
const common = await import(`${LIB}task/common/index.mjs`);
const arb = await import(`${LIB}task/arbitration.mjs`);
const pv2 = await import(`${LIB}task/common/pending-v2.mjs`);
const deliv = await import(`${LIB}task/common/deliverables.mjs`);
const gate = await import(`${LIB}task/common/review-gate.mjs`);
const notify = await import(`${LIB}task/common/prefilled-notify.mjs`);
const rating = await import(`${LIB}task/common/prefilled-rating.mjs`);
const funding = await import(`${LIB}task/common/funding-notice.mjs`);
const upload = await import(`${LIB}task/common/dispute-upload.mjs`);
const dispute = await import(`${LIB}task/_dispute-status.mjs`);
const rs = await import(`${LIB}_rs.mjs`);
const { stringify } = await import('../../skill/onchainos-lite/lib/core/json.mjs');

// Capture process.stdout writes made by handlers that print their own output.
async function captureStdout(fn) {
  const orig = process.stdout.write;
  let buf = '';
  process.stdout.write = (chunk, ...rest) => { buf += String(chunk); const cb = rest.find((r) => typeof r === 'function'); if (cb) cb(); return true; };
  try { await fn(); } finally { process.stdout.write = orig; }
  return buf;
}

// ── state_machine.rs ─────────────────────────────────────────────────────

test('state machine: dispute round labels', () => {
  const cases = [[0, 'Evaluation round initializing'], [1, 'Vote commitment in progress'], [2, 'Vote reveal in progress'],
    [3, 'Evaluation round completed'], [4, 'Evaluation round rejected'], [5, 'Evaluation round invalidated'], [99, 'Round status unavailable']];
  for (const [code, label] of cases) {
    const s = sm.DisputeRoundStatus.fromInt(code);
    assert.equal(sm.DisputeRoundStatus.displayLabel(s), label);
    assert.ok(sm.DisputeRoundStatus.displayDescription(s).trim() !== '');
  }
});

test('state machine: entry_event / status_when_event round-trip', () => {
  for (const s of ['created', 'accepted', 'submitted', 'rejected', 'disputed', 'completed', 'close', 'expired', 'failed']) {
    const e = sm.entryEvent(s);
    assert.ok(e, `entry event for ${s}`);
    assert.equal(sm.statusWhenEvent(e), s);
  }
  assert.equal(sm.entryEvent('admin_stopped'), undefined);
});

test('state machine: parse_status_or_event and pass-through events', () => {
  assert.equal(sm.parseStatusOrEvent('provider_applied'), 'provider_applied');
  assert.equal(sm.parseStatusOrEvent('created'), 'job_created');
  assert.equal(sm.parseStatusOrEvent('submitted'), 'job_submitted');
  for (const e of ['job_provider_reject', 'job_user_reject', 'job_asp_selected']) {
    assert.equal(sm.Event.parse(e), e);
    assert.equal(sm.parseStatusOrEvent(e), e);
    assert.equal(sm.statusWhenEvent(e), 'created');
  }
  assert.equal(sm.statusWhenEvent('provider_applied'), 'created');
  assert.ok(sm.Status.isTerminal('expired') && sm.Status.isTerminal('close') && sm.Status.isTerminal('failed'));
  assert.equal(sm.statusWhenEvent('submit_expired'), 'expired');
});

test('state machine: refund timeout events and notification/subscription placeholders', () => {
  for (const [name, status] of [['job_asp_accept_expire', 'expired'], ['job_asp_reject_closed', 'close'], ['job_asp_reject_expire', 'failed']]) {
    assert.equal(sm.Event.parse(name), name);
    assert.equal(sm.parseStatusOrEvent(name), name);
    assert.equal(sm.statusWhenEvent(name), status);
  }
  assert.equal(sm.statusWhenEvent('sub_asp_claim_notify'), 'notification');
  for (const e of ['sub_open', 'sub_created', 'sub_asp_selected', 'sub_cancel', 'sub_user_reject', 'sub_asp_agree', 'sub_asp_dispute',
    'sub_trial_into_active', 'sub_renew', 'sub_expire_warn', 'sub_complete_notify', 'sub_close_notify', 'sub_failed_notify', 'sub_reject_refund_notify']) {
    assert.ok(!sm.Event.isOther(e), e);
    assert.equal(sm.statusWhenEvent(e), 'subscription', e);
  }
  assert.ok(sm.Event.isOther('sub_trial_cancel'));
  assert.ok(sm.Event.isOther('job_visibility_changed'));
});

test('state machine: SubStatus codes, terminal flags, transitions', () => {
  for (const code of [-1, 0, 1, 3, 4, 6, 7, 8, 9]) assert.equal(sm.SubStatus.code(sm.SubStatus.fromCode(code)), code);
  for (const code of [99, -2, 2, 5]) assert.equal(sm.SubStatus.fromCode(code), 'Init');
  for (const s of ['Init', 'Created', 'Active', 'Rejected', 'Disputed']) assert.ok(!sm.SubStatus.isTerminal(s));
  for (const s of ['Expired', 'Completed', 'Failed', 'Closed']) assert.ok(sm.SubStatus.isTerminal(s));
  const can = sm.SubStatus.canTransitionTo;
  assert.ok(can('Init', 'Created') && !can('Init', 'Active') && !can('Init', 'Failed'));
  assert.ok(can('Created', 'Active') && can('Created', 'Closed') && can('Created', 'Expired'));
  assert.ok(can('Active', 'Rejected') && can('Active', 'Completed') && can('Active', 'Closed') && !can('Active', 'Failed'));
  assert.ok(can('Rejected', 'Failed') && can('Rejected', 'Disputed') && !can('Rejected', 'Active'));
  assert.ok(can('Disputed', 'Completed') && can('Disputed', 'Failed') && !can('Disputed', 'Active'));
  for (const s of ['Expired', 'Completed', 'Failed', 'Closed']) assert.ok(!can(s, 'Active'));
});

test('state machine: sub_status_after_event and parse_sub_status', () => {
  const m = { sub_asp_selected: 'Active', sub_trial_into_active: 'Active', sub_user_reject: 'Rejected', sub_asp_agree: 'Failed',
    sub_asp_dispute: 'Disputed', sub_complete_notify: 'Completed', sub_close_notify: 'Closed', sub_failed_notify: 'Failed', sub_reject_refund_notify: 'Failed' };
  for (const [e, s] of Object.entries(m)) assert.equal(sm.subStatusAfterEvent(e), s, e);
  for (const e of ['sub_renew', 'sub_expire_warn', 'sub_cancel', 'job_created']) assert.equal(sm.subStatusAfterEvent(e), undefined, e);
  const p = { '-1': 'Init', 0: 'Created', 1: 'Active', 6: 'Completed', 7: 'Closed', 8: 'Expired', 9: 'Failed' };
  for (const [code, s] of Object.entries(p)) assert.equal(sm.parseSubStatus(String(code)), s);
  for (const [txt, s] of [['Active', 'Active'], ['CREATED', 'Created'], ['expired', 'Expired'], ['REJECTED', 'Rejected'], ['completed', 'Completed'], ['garbage', 'Init']]) {
    assert.equal(sm.parseSubStatus(txt), s);
  }
});

// ── template_vars.rs ─────────────────────────────────────────────────────

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64Title = (t) => b64(JSON.stringify({ __OKX_TASK_TITLE__: t }));
const tvKind = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof tv.TemplateVarError, String(e)); return e.kind; } return 'ok'; };

test('template vars: decode happy path and every Invalid trigger', () => {
  const vars = tv.decodeAndValidate(b64Title('Weekly Report'));
  assert.equal(vars.get('__OKX_TASK_TITLE__'), 'Weekly Report');
  assert.equal(vars.size, 1);
  assert.equal(tvKind(() => tv.decodeAndValidate('not_base64!!!')), 'Invalid');
  assert.equal(tvKind(() => tv.decodeAndValidate(Buffer.from([0xff, 0xfe]).toString('base64'))), 'Invalid');
  for (const s of ['[1,2,3]', '"a string"', '42', 'null', '{"__EVIL__":"x"}', '{"__OKX_TASK_TITLE__":123}',
    '{"__OKX_TASK_TITLE__":{"nested":1}}', '{"__OKX_TASK_TITLE__":["a"]}', '{"__OKX_TASK_TITLE__":true}', '{"__OKX_TASK_TITLE__":null}',
    '{"__OKX_TASK_TITLE__":"a","__OKX_TASK_TITLE__":"b"}']) {
    assert.equal(tvKind(() => tv.decodeAndValidate(b64(s))), 'Invalid', s);
  }
  assert.equal(tvKind(() => tv.decodeAndValidate(b64Title('a'.repeat(tv.MAX_TEMPLATE_VALUE_LEN + 1)))), 'Invalid');
  assert.equal(tvKind(() => tv.decodeAndValidate(b64Title('a'.repeat(tv.MAX_TEMPLATE_VALUE_LEN)))), 'ok');
  const padded = `{"__OKX_TASK_TITLE__":"x"}${' '.repeat(tv.MAX_TEMPLATE_PAYLOAD_BYTES)}`;
  assert.equal(tvKind(() => tv.decodeAndValidate(b64(padded))), 'Invalid');
  assert.equal(new tv.TemplateVarError('Invalid').code, 'TEMPLATE_VARS_INVALID');
  assert.equal(new tv.TemplateVarError('ValueMissing').code, 'TEMPLATE_VALUE_MISSING');
  assert.equal(new tv.TemplateVarError('PlaceholderMissing').code, 'TEMPLATE_PLACEHOLDER_MISSING');
});

test('template vars: render_all bijection, single pass, i18n round-trip', () => {
  assert.equal(tvKind(() => tv.renderAll(['title is {{__OKX_TASK_TITLE__}} here'], new Map())), 'ValueMissing');
  const v = new Map([['__OKX_TASK_TITLE__', 'Report']]);
  assert.equal(tvKind(() => tv.renderAll(['no placeholder here', 'still none'], v)), 'PlaceholderMissing');
  assert.deepEqual(tv.renderAll(['plain user content', '[Decision 0xabc] {{__OKX_TASK_TITLE__}} decision'], v), ['plain user content', '[Decision 0xabc] Report decision']);
  assert.deepEqual(tv.renderAll(['a', 'b'], new Map()), ['a', 'b']);
  assert.equal(tv.renderAll(['X {{__OKX_TASK_TITLE__}} Y'], new Map([['__OKX_TASK_TITLE__', '{{__OKX_TASK_TITLE__}}']]))[0], 'X {{__OKX_TASK_TITLE__}} Y');
  assert.equal(tv.renderAll(['{{__OKX_TASK_TITLE__}} and {{__OKX_TASK_TITLE__}}'], new Map([['__OKX_TASK_TITLE__', 'T']]))[0], 'T and T');
  for (const title of ['中文标题🚀', "Oli's task", 'line1\nline2', '`id`', '$(touch /tmp/x)', '"; id; #', 'a\\b', 'emoji 😀 mix 中文']) {
    const vars = tv.decodeAndValidate(b64Title(title));
    assert.equal(vars.get('__OKX_TASK_TITLE__'), title);
    assert.equal(tv.renderAll(['[Decision 0x1] {{__OKX_TASK_TITLE__}} decision'], vars)[0], `[Decision 0x1] ${title} decision`);
  }
});

// ── user_lang.rs ─────────────────────────────────────────────────────────

test('user lang: detect', () => {
  assert.equal(lang.detect('跳过本次'), 'zh');
  assert.equal(lang.detect('A 自动,每笔100'), 'zh');
  assert.equal(lang.detect('install and execute'), 'en');
  assert.equal(lang.detect('yes'), 'en');
  for (const t of ['A', 'b', '100u', '100', '', '0x8f3A9bDeadBeef00112233445566778899aabbcc', 'deadbeef', '100USDT', 'SKIP', 'https://www.okx.com/trade', 'nico@okx.com']) {
    assert.equal(lang.detect(t), undefined, t);
  }
  assert.equal(lang.detect('buy 100USDT now please'), 'en');
  assert.equal(lang.detect('买 0x8f3A9bDeadBeef'), 'zh');
});

test('user lang: resolve layers job, then default, then en', () => {
  assert.equal(lang.resolve('job1'), 'en');
  lang.recordFromUserText('job1', 'A');
  assert.equal(lang.resolve('job1'), 'en');
  lang.recordFromUserText('job1', 'A 自动,每笔100');
  assert.equal(lang.resolve('job1'), 'zh');
  assert.equal(lang.resolve('job2'), 'zh');
  lang.recordFromUserText('job2', 'skip this trade');
  assert.equal(lang.resolve('job2'), 'en');
  assert.equal(lang.resolve('job1'), 'zh');
  assert.equal(lang.resolve('job3'), 'en');
  lang.recordFromUserText('../evil', '跳过');
  assert.equal(lang.resolve('../evil'), 'zh');
  assert.ok(!existsSync(join(HOME, 'autotrade', 'evil')));
});

// ── deadline.rs ──────────────────────────────────────────────────────────

const DAY = 86400, HOUR = 3600, NOW = 1_000_000_000;
const I64_MAX = 9223372036854775807n;

test('deadline: days_left', () => {
  assert.equal(dl.daysLeft(NOW + 3 * DAY, NOW), 3);
  assert.equal(dl.daysLeft(NOW + 2 * HOUR, NOW), 1);
  assert.equal(dl.daysLeft(NOW + 6 * HOUR, NOW), 1);
  assert.equal(dl.daysLeft(NOW + 3 * DAY + 1, NOW), 4);
  assert.equal(dl.daysLeft(NOW - 1, NOW), 0);
  assert.equal(dl.daysLeft(NOW, NOW), 0);
});

test('deadline: local / utc formatting and timestamp parsing', () => {
  const s = dl.formatLocalDeadline(NOW);
  assert.equal(s.length, 'MM-DD HH:mm'.length);
  assert.equal(s[2], '-');
  assert.equal(s[8], ':');
  assert.equal(dl.formatLocalDeadline(I64_MAX), undefined);
  assert.equal(dl.formatUtcTimestamp(1_700_000_000), '2023-11-14 22:13 (UTC+00:00)');
  assert.equal(dl.formatUtcTimestamp(1_700_000_000_000), '2023-11-14 22:13 (UTC+00:00)');
  assert.equal(dl.formatUtcTimestamp(I64_MAX), undefined);
  assert.equal(dl.parseTimestampSeconds('1700000000'), 1_700_000_000);
  assert.equal(dl.parseTimestampSeconds('1700000000000'), 1_700_000_000);
  assert.equal(dl.parseTimestampSeconds('2023-11-14T22:13:20Z'), 1_700_000_000);
  assert.equal(dl.reviewDeadlineFromDetail({ reviewDeadlineAt: 1_700_000_123, submittedAt: 1_700_000_000 }), 1_700_000_123);
  assert.equal(dl.reviewDeadlineFromDetail({ submittedAt: 1_700_000_000_000 }), 1_700_000_000 + dl.REVIEW_WINDOW_SECONDS);
  assert.equal(dl.reviewDeadlineFromDetail({}), undefined);
});

test('deadline: reminder lines', () => {
  const w = (t) => dl.formatLocalDeadline(t);
  assert.equal(dl.deadlineReminderLine(NOW + 3 * DAY, NOW, dl.DeadlineKind.Review),
    `⏰ Review deadline: 3 day(s) (by ${w(NOW + 3 * DAY)}). If not reviewed in time, the system will auto-accept and release payment to the ASP — irreversible.`);
  assert.equal(dl.deadlineReminderLine(NOW - 1, NOW, dl.DeadlineKind.Review),
    `⏰ Review deadline has passed (${w(NOW - 1)}). The system may auto-accept at any time.`);
  assert.equal(dl.deadlineReminderLine(NOW + DAY, NOW, dl.DeadlineKind.Decision),
    `⏰ Decision deadline: 1 day(s) (by ${w(NOW + DAY)}). If not decided in time, the system will auto-refund to the buyer — irreversible.`);
  assert.equal(dl.deadlineReminderLine(NOW - 1, NOW, dl.DeadlineKind.Decision),
    `⏰ Decision deadline has passed (${w(NOW - 1)}). The system may auto-refund to the buyer at any time.`);
  assert.equal(dl.deadlineReminderLine(undefined, NOW, dl.DeadlineKind.Review), undefined);
  assert.equal(dl.deadlineReminderLine(0, NOW, dl.DeadlineKind.Review), undefined);
  assert.equal(dl.deadlineReminderLine(-5, NOW, dl.DeadlineKind.Decision), undefined);
  assert.equal(dl.deadlineReminderLine(I64_MAX, NOW, dl.DeadlineKind.Review), undefined);
});

// ── util.rs ──────────────────────────────────────────────────────────────

test('util: short_job_id and sanitize_title_for_shell', () => {
  assert.equal(util.shortJobId('0x1b76dabd3bf884626184e3b36b7c65b54929a827a8a26e223c4b8aa868d41be1'), '0x1b76…1be1');
  for (const s of ['0x12', 'task-1', 'task-001-12']) assert.equal(util.shortJobId(s), s);
  assert.equal(util.shortJobId('task-001-very-long'), 'task-0…long');
  assert.equal(util.sanitizeTitleForShell(''), '');
  assert.equal(util.sanitizeTitleForShell('&;|'), '');
  assert.equal(util.sanitizeTitleForShell('A & B  C > D'), 'A B C D');
  assert.equal(util.sanitizeTitleForShell('钱包税务 & 合规报告'), '钱包税务 合规报告');
  assert.equal(util.sanitizeTitleForShell('Normal Title: Hello'), 'Normal Title: Hello');
  assert.equal(util.sanitizeTitleForShell('Wallet Tax & Compliance Report'), 'Wallet Tax Compliance Report');
  assert.equal(util.sanitizeTitleForShell('a$(b)`c`!d'), 'abcd');
});

test('util: job id validators', () => {
  for (const ok of ['report-42', 'system_voter_staking', 'a', '0'.repeat(256), `0x${'a'.repeat(64)}`]) util.validateJobIdPathComponent(ok);
  const bad = ['', '../secret', 'a/b', 'a\\b', '.', '..', '/etc/passwd', '0'.repeat(257), 'a\u0000b', 'a\nb'];
  if (process.platform === 'win32') bad.push('C:\\x', 'C:x');
  for (const b of bad) {
    assert.throws(() => util.validateJobIdPathComponent(b), (e) => e.code === 'UNSAFE_JOB_PATH_COMPONENT' || e.errorCode === 'UNSAFE_JOB_PATH_COMPONENT', JSON.stringify(b));
  }
  assert.equal(util.validateJobId(`0x${'ab'.repeat(32)}`), undefined);
  assert.equal(util.validateJobId('_'), undefined);
  assert.equal(util.validateJobId('system_x'), undefined);
  assert.match(util.validateJobId('0x12'), /^--jobid invalid \(must be `0x` \+ 64 chars, got 4 chars\)/);
});

// ── agent_commerce/mod.rs ────────────────────────────────────────────────

test('mod: escape_control_chars_in_strings', () => {
  assert.equal(root.escapeControlCharsInStrings('{"text":"line1\nline2"}'), '{"text":"line1\\nline2"}');
  assert.equal(root.escapeControlCharsInStrings('{\n"k":"v"\n}'), '{\n"k":"v"\n}');
  const pre = '{"text":"a\\nb\\"c"}';
  assert.equal(root.escapeControlCharsInStrings(pre), pre);
  assert.equal(root.escapeControlCharsInStrings('{"text":"a\rb\tc"}'), '{"text":"a\\rb\\tc"}');
  assert.equal(JSON.parse(root.escapeControlCharsInStrings('{"event":"deliverable_received","text":"line1\nline2"}')).text, 'line1\nline2');
});

test('mod: detail ownership / legacy a2mcp / refund status policies', () => {
  assert.ok(root.handlerFetchesOwnTaskDetail('user', 'job_completed'));
  assert.ok(root.handlerFetchesOwnTaskDetail('asp', 'job_completed'));
  assert.ok(!root.handlerFetchesOwnTaskDetail('evaluator', 'job_completed'));
  assert.ok(root.handlerFetchesOwnTaskDetail('user', 'sub_complete_notify'));
  assert.ok(!root.handlerFetchesOwnTaskDetail('asp', 'sub_complete_notify'));
  assert.ok(!root.handlerFetchesOwnTaskDetail('user', 'sub_close_notify'));
  assert.ok(!root.shouldBlockLegacyA2mcpFlow(3, 'sub_complete_notify'));
  assert.ok(!root.shouldBlockLegacyA2mcpFlow(3, 'job_completed'));
  assert.ok(root.shouldBlockLegacyA2mcpFlow(3, 'job_submitted'));
  assert.ok(!root.shouldBlockLegacyA2mcpFlow(null, 'job_submitted'));
  assert.deepEqual(root.refundEventStatusPolicy('job_closed'), [7, true]);
  assert.deepEqual(root.refundEventStatusPolicy('sub_asp_agree'), [9, true]);
  assert.deepEqual(root.refundEventStatusPolicy('submit_expired'), [8, false]);
  assert.deepEqual(root.refundEventStatusPolicy('job_asp_reject_expire'), [9, true]);
  assert.equal(root.refundEventStatusPolicy('job_created'), undefined);
  assert.equal(root.buyerRefundEventStatusPolicy('asp', 'job_closed'), undefined);
  assert.deepEqual(root.buyerRefundEventStatusPolicy('user', 'job_closed'), [7, true]);
  assert.equal(root.subscriptionAcceptanceStatus({ subStatus: '3' }), 3);
  assert.equal(root.subscriptionAcceptanceStatus({ status: 9 }), 9);
  assert.equal(root.subscriptionAcceptanceStatus({ subStatus: 'x' }), undefined);
  const ctx = common.PreFetchedTaskContext.fromApiResponse({ providerAgentId: '2002', status: 7 });
  assert.equal(root.aspRefundContextBlockReason(ctx, 'job_closed', '2002'), undefined);
  assert.match(root.aspRefundContextBlockReason(ctx, 'job_refunded', '2002'), /status Some\(7\) does not match job_refunded expected status 9/);
  assert.match(root.aspRefundContextBlockReason(ctx, 'job_closed', '9999'), /does not bind job_closed to ASP 9999/);
  assert.equal(root.txFailureLabel('no_such_event'), 'transaction failed');
});

// ── task/common/mod.rs ───────────────────────────────────────────────────

test('common: PreFetchedTaskContext.from_api_response deadlines and subscription fields', () => {
  const now = Math.floor(Date.now() / 1000);
  let c = common.PreFetchedTaskContext.fromApiResponse({ expireTime: now + 3 * DAY });
  assert.equal(c.expireTime, now + 3 * DAY);
  assert.equal(c.reviewExpireTime, now + 3 * DAY);
  c = common.PreFetchedTaskContext.fromApiResponse({ submittedAt: 1_700_000_000_000 });
  assert.equal(c.reviewExpireTime, 1_700_000_000 + 3 * DAY);
  c = common.PreFetchedTaskContext.fromApiResponse({ expireTime: null, submittedAt: 1_700_000_000, expireConfig: { reviewDeadline: 123 } });
  assert.equal(c.expireTime, null);
  assert.equal(c.reviewExpireTime, 1_700_000_000 + 3 * DAY);
  c = common.PreFetchedTaskContext.fromApiResponse({ title: 'x' });
  assert.equal(c.expireTime, null);
  assert.equal(c.reviewExpireTime, null);
  c = common.PreFetchedTaskContext.fromApiResponse({ subStatus: '0', userAgentId: 'buyer-1', aspAgentId: 'asp-1', aspAgentName: 'Alice ASP', serviceName: 'Audit',
    paymentTokenAmount: '10.00', paymentTokenSymbol: 'USDT', paymentTokenAddress: '0xtoken', refundReason: 'Delivery did not match the request',
    subStartTime: 1_700_000_000, subEndTime: 1_700_500_000, rejectWindowEndsAt: 1_700_600_000 });
  assert.equal(c.status, 0);
  assert.equal(c.userAgentId, 'buyer-1');
  assert.equal(c.providerAgentId, 'asp-1');
  assert.equal(c.providerName, 'Alice ASP');
  assert.equal(c.serviceName, 'Audit');
  assert.equal(c.tokenAmount, '10.00');
  assert.equal(c.tokenSymbol, 'USDT');
  assert.equal(c.tokenAddress, '0xtoken');
  assert.equal(c.refundReason, 'Delivery did not match the request');
  assert.equal(c.periodStartTime, 1_700_000_000);
  assert.equal(c.periodEndTime, 1_700_500_000);
  assert.equal(c.expireTime, 1_700_600_000);
  assert.equal(c.reviewExpireTime, null);
  assert.equal(common.PreFetchedTaskContext.fromApiResponse({ expireTime: 0 }).expireTime, null);
  c = common.PreFetchedTaskContext.fromApiResponse({ expireTime: 0, expireConfig: { reviewDeadline: DAY } });
  assert.equal(c.expireTime, null);
  assert.equal(c.reviewExpireTime, null);
  assert.equal(common.PreFetchedTaskContext.fromApiResponse({ title: 'x', testFlag: true }).testFlag, true);
  assert.equal(common.PreFetchedTaskContext.fromApiResponse({ title: 'x' }).testFlag, false);
  assert.equal(common.PreFetchedTaskContext.fromApiResponse({ title: 'x', testFlag: 'true' }).testFlag, false);
});

test('common: find_service_in_data scans every group', () => {
  const data = [{ list: [{ serviceId: 'svc-a', endpoint: 'https://a' }] },
    { list: [{ serviceId: 'svc-b', endpoint: 'https://b' }, { serviceId: 'svc-target', endpoint: 'https://target' }] }];
  assert.equal(common.findServiceInData(data, 'svc-target').endpoint, 'https://target');
  assert.equal(common.findServiceInData([{ list: [{ id: 100, endpoint: 'https://a' }] }, { list: [{ id: 2301, endpoint: 'https://target' }] }], '2301').endpoint, 'https://target');
  assert.equal(common.findServiceInData([{ list: [{ serviceId: 'svc-a' }] }, { list: [{ serviceId: 'svc-b' }] }], 'svc-missing'), undefined);
});

// ── task/arbitration.rs ──────────────────────────────────────────────────

test('arbitration: decision result shape for both task types', () => {
  for (const source of [arb.JOB_REJECTED, arb.SUB_USER_REJECT]) {
    const message = source === arb.SUB_USER_REJECT
      ? { periodIndex: 2, subStartTime: 1_699_000_000, subEndTime: 1_700_000_000, refundReason: 'Delivery did not match the request', rejectWindowEndsAt: 1_700_100_000 }
      : { refundReason: 'Delivery did not match the request', expireTime: 1_700_100_000 };
    const r = arb.buildDecisionResult(source, 'job-1', 'Service', '1.25', 'USDT', message);
    assert.equal(r.phase, 'arbitration_decision');
    assert.equal(r.decision, 'requires_user_input');
    assert.equal(r.nextAction.length, 2);
    assert.equal(r.payload.name, 'Service');
  }
});

test('arbitration: refund card fields and metadata round-trip', () => {
  const r = arb.buildDecisionResult(arb.SUB_USER_REJECT, 'job-1', 'Task title', '1.25', 'USDT',
    { serviceName: 'Signal Service', refundReason: 'Signals were not delivered', subStartTime: 1_699_000_000, subEndTime: 1_700_000_000, rejectWindowEndsAt: 1_700_000_000 });
  assert.equal(r.payload.serviceName, 'Signal Service');
  assert.equal(r.payload.refundReason, 'Signals were not delivered');
  assert.equal(typeof r.payload.responseDeadline, 'string');
  assert.equal(r.payload.responseDeadlineLabel, '2023-11-14 22:13 (UTC+00:00)');
  assert.equal(r.payload.statusLabel, 'Awaiting ASP decision');
  assert.equal(r.payload.statusDescription, "The refund request is waiting for the ASP's decision.");
  const meta = arb.RefundDisplayMetadata.decode(r.payload.refundDisplayB64);
  assert.equal(meta.serviceName, 'Signal Service');
  assert.equal(meta.taskType, 'Subscription');
  assert.equal(meta.refundAmountLabel(), '1.25 USDT');
  for (const a of r.nextAction) {
    assert.equal(a.params.decisionBindingKey, 'subStartTime');
  }
  const blocked = arb.buildDecisionResult(arb.JOB_REJECTED, 'job-1', undefined, '1', 'USDT', undefined);
  assert.equal(blocked.decision, 'blocked');
  assert.equal(blocked.reason, 'missing_required_facts');
  assert.deepEqual(blocked.nextAction, []);
});

test('arbitration: subscription choices carry the period binding', () => {
  const r = arb.buildDecisionResult(arb.SUB_USER_REJECT, 'job-1', 'Service', '1', 'USDT',
    { periodIndex: 2, subStartTime: 1_699_000_000, subEndTime: 1_700_000_000, refundReason: 'Delivery did not match the request', rejectWindowEndsAt: 1_700_100_000 });
  for (const a of r.nextAction) {
    assert.equal(a.params.decisionBindingKey, 'periodIndex');
    assert.equal(a.params.decisionBindingValue, '2');
  }
  assert.notEqual(arb.decisionId(arb.SUB_USER_REJECT, 'job-1', { periodIndex: 2 }), arb.decisionId(arb.SUB_USER_REJECT, 'job-1', { periodIndex: 3 }));
  assert.equal(arb.decisionId(arb.JOB_REJECTED, 'job-1', undefined), 'job-1:job_rejected:current');
});

const choiceKind = (fn) => { try { return fn(); } catch (e) { assert.ok(e instanceof arb.ChoiceError, String(e)); return e.kind; } };

test('arbitration: deterministic reply mapping', () => {
  const choices = arb.defaultChoices(arb.JOB_REJECTED, 'job-1');
  assert.equal(arb.resolveChoice(arb.JOB_REJECTED, choices, 'Approve refund').actionId, 'agree_refund');
  assert.equal(choiceKind(() => arb.resolveChoice(arb.JOB_REJECTED, choices, 'File for evaluation')), 'MissingReason');
  const ev = arb.resolveChoice(arb.JOB_REJECTED, choices, 'File for evaluation: delivery was incomplete');
  assert.equal(ev.actionId, 'raise_arbitration');
  assert.equal(ev.params.reason, 'delivery was incomplete');
  assert.equal(arb.resolveChoice(arb.JOB_REJECTED, choices, 'B reason: delivery below expectation').params.reason, 'delivery below expectation');
  assert.equal(arb.resolveChoice(arb.JOB_REJECTED, choices, 'A').actionId, 'agree_refund');
  assert.equal(choiceKind(() => arb.resolveChoice(arb.JOB_REJECTED, choices, 'Request evaluation')), 'MissingReason');
  const sel = arb.resolveChoice(arb.JOB_REJECTED, choices, 'Request evaluation: the delivery met the agreed requirements');
  assert.equal(sel.actionId, 'raise_arbitration');
  assert.equal(sel.params.reason, 'the delivery met the agreed requirements');
  assert.equal(arb.resolveChoice(arb.JOB_REJECTED, choices, 'request evaluation reason: delivery meets the specification').params.reason, 'delivery meets the specification');
  assert.equal(choiceKind(() => arb.resolveChoice(arb.JOB_REJECTED, choices, 'B')), 'MissingReason');
  const sub = arb.defaultChoices(arb.SUB_USER_REJECT, 'job-1');
  assert.equal(choiceKind(() => arb.resolveChoice(arb.SUB_USER_REJECT, sub, 'OK')), 'Ambiguous');
  assert.equal(choiceKind(() => arb.resolveChoice(arb.SUB_USER_REJECT, sub, 'A or B')), 'Ambiguous');
  assert.equal(new arb.ChoiceError('MissingReason').reasonCode(), 'arbitration_reason_required');
});

test('arbitration: choices validation and envelope binding', () => {
  const reversed = JSON.stringify([{ key: 'A', actionId: 'raise_arbitration', params: {} }, { key: 'B', actionId: 'agree_refund', params: {} }]);
  assert.throws(() => arb.parseChoices(reversed, arb.JOB_REJECTED, 'job-1'));
  const tampered = arb.defaultChoices(arb.JOB_REJECTED, 'job-2');
  tampered[0].params.jobId = 'job-1';
  assert.throws(() => arb.parseChoices(arb.choicesJson(tampered), arb.JOB_REJECTED, 'job-2'));
  assert.equal(choiceKind(() => arb.resolvedAction(arb.JOB_REJECTED, 'agree_refund', 'job-2', { jobId: 'job-1' })), 'UnsupportedAction');
  assert.equal(choiceKind(() => arb.resolvedAction(arb.JOB_REJECTED, 'raise_arbitration', 'job-2', { jobId: 'job-2' })), 'MissingReason');
  const legacy = JSON.stringify([{ key: 'A', actionId: 'agree_refund', params: { jobId: 'job-1' } }, { key: 'B', actionId: 'dispute_raise', params: { jobId: 'job-1' } }]);
  assert.equal(arb.parseChoices(legacy, arb.JOB_REJECTED, 'job-1')[1].actionId, 'raise_arbitration');
  assert.equal(arb.resolvedAction(arb.JOB_REJECTED, 'dispute_raise', 'job-1', { jobId: 'job-1', reason: 'completed as agreed' }).actionId, 'raise_arbitration');
  assert.throws(() => arb.parseChoices('{', arb.JOB_REJECTED, 'job-1'), /^Error: invalid --choices-json: /);
});

test('arbitration: list result exposes stable selection ids', () => {
  const items = [[{ jobId: 'job-1', title: 'Research', status: 4, testFlag: true, createTime: 1_700_000_000 }, null]];
  const r = arb.buildListResult(1, 1, items, false);
  const it = r.payload.items[0];
  assert.equal(r.phase, 'arbitration_list');
  assert.equal(it.jobId, 'job-1');
  assert.ok(!('testFlag' in it));
  assert.equal(it.description, 'Research');
  assert.equal(it.occurredAt, 1_700_000_000);
  assert.equal(it.taskStatus, 'disputed');
  assert.equal(it.taskStatusLabel, 'Evaluation in progress');
  assert.equal(it.arbitrationPhaseDescription, 'The Evaluation stage is currently unavailable.');
  assert.equal(it.status, 'Status unavailable');
  assert.equal(it.evaluationStatus, 'unknown');
  assert.equal(it.statusLabel, 'Status unavailable');
  assert.equal(it.statusDescription, 'The Evaluation status is currently unavailable.');
  assert.equal(it.verdictLabel, 'Not decided');
  assert.equal(it.verdict, null);
  assert.equal(r.nextAction[0].id, 'view_arbitration');
  assert.deepEqual(r.nextAction[0].params.allowedJobIds, ['job-1']);
  assert.equal(r.nextAction[0].params.confirmationRequired, false);
  assert.equal(arb.buildListResult(1, 1, items, true).payload.items[0].testFlag, true);
});

test('dispute status decode: serde error text and aliases', () => {
  assert.throws(() => dispute.decodeDisputeStatus({ jobId: 'j', taskStatus: 'four' }), /^Error: invalid type: string "four", expected i32$/);
  const d = dispute.decodeDisputeStatus({ jobId: 'j', disputeStatus: 2, selectedVoter: { agentId: 'x' } });
  assert.equal(d.disputeRoundStatus, 2);
  assert.equal(d.taskStatus, 0);
  assert.throws(() => dispute.decodeDisputeStatus({}), /missing field `jobId`/);
});

// ── pending_v2.rs ────────────────────────────────────────────────────────

test('pending v2: title / refund template vars round-trip', () => {
  for (const title of ['Weekly Report', '中文标题🚀', "Oli's task", '`id`', '$(touch /tmp/x)', '"; id; #']) {
    const label = `<label>${title}`;
    const vars = tv.decodeAndValidate(pv2.encodeTitleVars(title, label));
    assert.equal(vars.get('__OKX_TASK_TITLE__'), title);
    assert.equal(vars.get('__OKX_TASK_LABEL_TITLE__'), label);
  }
  const vars = tv.decodeAndValidate(pv2.encodeRefundDecisionVars('Signal Service', 'job-full-id', 'Subscription', '2026-09-01–2026-10-01', '1.25 USDT',
    '$(touch /tmp/must-not-run)', '2026-09-08 12:00 (UTC+08:00)'));
  const template = [tv.REFUND_SERVICE_NAME_PLACEHOLDER, tv.REFUND_JOB_ID_PLACEHOLDER, tv.REFUND_TASK_TYPE_PLACEHOLDER, tv.REFUND_CURRENT_PERIOD_PLACEHOLDER,
    tv.REFUND_AMOUNT_PLACEHOLDER, tv.REFUND_BUYER_REASON_PLACEHOLDER, tv.REFUND_RESPONSE_DEADLINE_PLACEHOLDER].join(' | ');
  const out = tv.renderAll([template, `[Decision job-full] ${tv.REFUND_SERVICE_NAME_PLACEHOLDER} — refund or evaluation`], vars);
  for (const s of ['Signal Service', 'job-full-id', '$(touch /tmp/must-not-run)', '2026-09-01–2026-10-01']) assert.ok(out[0].includes(s), s);
  assert.ok(out[1].includes('Signal Service'));
  assert.ok(!out.some((v) => v.includes('{{__OKX_')));
});

test('pending v2: request command block escapes user content only', () => {
  const block = pv2.requestCommandBlock('0xjob', 'user', '1001', '2002', 'say "hi" \\ now', 'Label', 'job_submitted');
  assert.ok(block.startsWith('**Localize first**'));
  assert.ok(block.includes('--job-id 0xjob --role user --agent-id 1001 --to-agent-id "2002" \\\n'));
  assert.ok(block.includes('--user-content "say \\"hi\\" \\\\ now"'));
  assert.ok(block.endsWith('--source-event job_submitted\n```'));
  assert.ok(!pv2.requestCommandBlock('0xjob', 'user', '1001', null, 'x', 'L', 'e').includes('--to-agent-id'));
  assert.equal(pv2.roleShortLabel('asp'), 'ASP');
});

test('pending v2: queue-mode request persists before the card push; list / cancel-all', async () => {
  const saved = { CLAUDECODE: process.env.CLAUDECODE, CODEX_THREAD_ID: process.env.CODEX_THREAD_ID, PATH: process.env.PATH };
  delete process.env.CLAUDECODE;
  delete process.env.CODEX_THREAD_ID;
  process.env.PATH = NOBIN;                       // okx-a2a can never be found → no real card push
  try {
    const job = `0x${'cd'.repeat(32)}`;
    await assert.rejects(captureStdout(() => pv2.handleRequestCommand({ jobId: job, role: 'asp', agentId: '2002', listLabel: '[Decision] price',
      userContent: 'Accept?\\nA) yes', sourceEvent: 'negotiate_reply' })), /spawn failed|program not found/);
    assert.ok(pv2.hasPendingForJob(job, 'asp'));
    assert.ok(!pv2.hasPendingForJob(job, 'user'));
    const listed = JSON.parse(await captureStdout(() => pv2.handleList('json', undefined)));
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].job_id, job);
    assert.equal(listed.entries[0].list_label, '[Decision] price');
    assert.equal(await pv2.cancelAllForJob(job), 1);
    assert.ok(!pv2.hasPendingForJob(job, 'asp'));
    const empty = JSON.parse(await captureStdout(() => pv2.handleList('json', undefined)));
    assert.deepEqual(empty.entries, []);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ── deliverables.rs / review_gate.rs / prefilled caches ─────────────────

test('deliverables: sanitize_title and review-card marker', () => {
  assert.equal(deliv.sanitizeTitle('Polymarket聪明钱信号', '0xabc'), 'Polymarket聪明钱信号');
  assert.equal(deliv.sanitizeTitle('ETH/BTC 分析: 2026', '0xabc'), 'ETHBTC分析2026');
  assert.equal(deliv.sanitizeTitle('a/*?b', '0xabc'), 'ab');
  assert.equal(deliv.sanitizeTitle('', '0xabcdef1234'), 'job_0xabcdef12');
  assert.equal(deliv.sanitizeTitle('/:*?', '0xabcdef1234'), 'job_0xabcdef12');
  assert.equal(deliv.sanitizeTitle('一二三四五六七八九十一二三四五六七八九十额外的字', '0xabc'), '一二三四五六七八九十一二三四五六七八九十');
  assert.equal(deliv.sanitizeTitle('  hello world  ', '0xabc'), 'helloworld');
  assert.ok(!deliv.hasReviewCardSentMarker('job-review-marker'));
  deliv.markReviewCardSent('job-review-marker');
  assert.ok(deliv.hasReviewCardSentMarker('job-review-marker'));
  assert.ok(!deliv.hasReviewCardSentMarker('another-job'));
});

test('review gate: delayed pending marker does not undo approval', () => {
  gate.markPending('job-review-gate');
  gate.markApproved('job-review-gate');
  gate.markPending('job-review-gate');
  gate.checkAndConsume('job-review-gate');
  assert.throws(() => gate.checkAndConsume('job-review-gate'), /review-gate file does not exist/);
  gate.markPending('job-review-gate-2');
  assert.throws(() => gate.checkAndConsume('job-review-gate-2'), /review-gate = pending/);
  assert.throws(() => gate.markApproved('job-review-gate-3'), /job_submitted flow was not executed/);
});

test('prefilled notify / rating caches', () => {
  notify.save('job-cache', 'job_completed', 'Done!');
  notify.save('job-cache', 'job_rejected', 'Rejected');
  assert.equal(notify.getPrefilled('job-cache', 'job_completed'), 'Done!');
  assert.equal(notify.getPrefilled('job-cache', 'missing'), undefined);
  assert.equal(readFileSync(join(HOME, 'task', 'job-cache', 'cache', 'prefilled-notify.json'), 'utf8'),
    '{\n  "job_completed": "Done!",\n  "job_rejected": "Rejected"\n}');
  notify.clear('job-cache');
  assert.equal(notify.getPrefilled('job-cache', 'job_completed'), undefined);
  rating.save('job-cache', '5', 'great');
  assert.deepEqual(rating.getPrefilled('job-cache'), { score: '5', comment: 'great' });
  assert.equal(readFileSync(join(HOME, 'task', 'job-cache', 'cache', 'prefilled-rating.json'), 'utf8'), '{\n  "score": "5",\n  "comment": "great"\n}');
  rating.clear('job-cache');
  assert.equal(rating.getPrefilled('job-cache'), undefined);
});

// ── funding_notice.rs (golden: upstream 4.6.3 stdout, PNG path substituted) ─

const UP_XLAYER = '{\n  "data": {\n    "available": "0",\n    "chain": "XLayer",\n    "contentCanonical": "Insufficient USDT balance on XLayer: shortfall 0.5 USDT.\\nAvailable: 0 USDT.\\nRequired: 0.5 USDT.\\n\\nDeposit address: 0x1234567890abcdef1234567890abcdef12345678\\nDeposit network: XLayer\\n\\nFunding options:\\n1. Scan and deposit — send USDT directly to the address above on XLayer.\\n2. Swap — swap <token> to 0.5 USDT on XLayer.\\n3. Bridge — bridge 0.5 USDT from <chain> to XLayer.\\n4. Withdraw from OKX — withdraw USDT to the address above using the XLayer network. The exchange may charge a withdrawal fee.\\n\\nOn-chain gas on X Layer is free after the funds arrive.\\n\\nAfter topping up, tell me \\"I topped up\\".",\n    "currency": "USDT",\n    "depositAddress": "0x1234567890abcdef1234567890abcdef12345678",\n    "depositChain": "XLayer",\n    "displayMode": "image-notify",\n    "displayPolicy": "Non-TTY: run notifyCommandArgs for PNG QR, put markdownImage under option 1, then repeat the full localized notice in final; never summarize.",\n    "endTurn": true,\n    "fallbackContentCanonical": "QR image could not be attached. Deposit USDT to 0x1234567890abcdef1234567890abcdef12345678 on XLayer. After topping up, tell me \\"I topped up\\".",\n    "forbidFundingSummary": true,\n    "imagePath": "<P>",\n    "markdownImage": "![QR Code](<<P>>)",\n    "mustLocalize": true,\n    "mustNotifyWithImagePath": true,\n    "mustRenderMarkdownImageBelowFirstOption": true,\n    "mustRepeatInFinalResponse": true,\n    "mustRunNotifyCommand": true,\n    "notifyCommand": "onchainos agent user-notify --content \\"$ONCHAINOS_FUNDING_NOTICE_CONTENT\\" --image-path \'<P>\'",\n    "notifyCommandArgs": [\n      "onchainos",\n      "agent",\n      "user-notify",\n      "--content",\n      "<localized content>",\n      "--image-path",\n      "<P>"\n    ],\n    "reason": "task-payment",\n    "required": "0.5",\n    "shortfall": "0.5",\n    "terminalQr": null\n  },\n  "ok": true\n}';
const UP_ETH = '{\n  "data": {\n    "available": null,\n    "chain": "Ethereum",\n    "contentCanonical": "Insufficient USDC balance on Ethereum: shortfall 12 USDC.\\n\\nDeposit address: 0xabc\\nDeposit network: Base\\n\\nFunding options:\\n1. Scan and deposit — send USDC directly to the address above on Base.\\n2. Swap — swap <token> to 12 USDC on Ethereum.\\n3. Bridge — bridge 12 USDC from <chain> to Ethereum.\\n4. Withdraw from OKX — withdraw USDC to the address above using the Base network. The exchange may charge a withdrawal fee.\\n\\nEnsure the wallet meets the network gas requirements.\\n\\nAfter topping up, tell me \\"I topped up\\".",\n    "currency": "USDC",\n    "depositAddress": "0xabc",\n    "depositChain": "Base",\n    "displayMode": "image-notify",\n    "displayPolicy": "Non-TTY: run notifyCommandArgs for PNG QR, put markdownImage under option 1, then repeat the full localized notice in final; never summarize.",\n    "endTurn": true,\n    "fallbackContentCanonical": "QR image could not be attached. Deposit USDC to 0xabc on Base. After topping up, tell me \\"I topped up\\".",\n    "forbidFundingSummary": true,\n    "imagePath": "<P>",\n    "markdownImage": "![QR Code](<<P>>)",\n    "mustLocalize": true,\n    "mustNotifyWithImagePath": true,\n    "mustRenderMarkdownImageBelowFirstOption": true,\n    "mustRepeatInFinalResponse": true,\n    "mustRunNotifyCommand": true,\n    "notifyCommand": "onchainos agent user-notify --content \\"$ONCHAINOS_FUNDING_NOTICE_CONTENT\\" --image-path \'<P>\'",\n    "notifyCommandArgs": [\n      "onchainos",\n      "agent",\n      "user-notify",\n      "--content",\n      "<localized content>",\n      "--image-path",\n      "<P>"\n    ],\n    "reason": "dispute-bond",\n    "required": null,\n    "shortfall": "12",\n    "terminalQr": null\n  },\n  "ok": true\n}';

test('funding notice: image-notify render matches upstream golden output', () => {
  const P = 'C:/h/tmp/funding-qr/onchainos-funding-qr-1-2.png';
  const qr = { displayMode: 'image-notify', imagePath: P, markdownImage: `![QR Code](<${P}>)`,
    notifyCommandArgs: ['onchainos', 'agent', 'user-notify', '--content', '<localized content>', '--image-path', P] };
  const render = (args) => {
    const [notice, path] = funding.buildFundingNoticeFromQr(funding.fundingNoticeInput(args), qr);
    assert.equal(path, P);
    return stringify({ ok: true, data: notice }, true);
  };
  assert.equal(render({ chain: 'XLayer', currency: 'USDT', shortfall: '0.5', depositAddress: '0x1234567890abcdef1234567890abcdef12345678', available: '0', required: '0.5', reason: 'task-payment' }),
    UP_XLAYER.split('<P>').join(P));
  assert.equal(render({ chain: ' Ethereum ', currency: 'USDC', shortfall: '12', depositAddress: '0xabc', depositChain: 'Base', reason: 'dispute-bond' }),
    UP_ETH.split('<P>').join(P));
});

test('funding notice: input validation, command and gas line', () => {
  assert.throws(() => funding.fundingNoticeInput({ chain: ' ', currency: 'USDT', shortfall: '1', depositAddress: '0xabc' }), /^Error: --chain must not be empty$/);
  assert.throws(() => funding.fundingNoticeInput({ chain: 'x', currency: 'USDT', shortfall: '1', depositAddress: '0xabc', depositChain: '  ' }), /--deposit-chain must not be empty/);
  assert.throws(() => funding.fundingNoticeInput({ chain: 'x', currency: 'USDT', shortfall: '1', depositAddress: '0xabc', notifyUser: true }), /--notify-user requires --content/);
  for (const chain of ['XLayer', 'X Layer', 'x-layer', 'xlayer']) {
    assert.ok(funding.renderContent(funding.fundingNoticeInput({ chain, currency: 'USDT', shortfall: '1', depositAddress: '0xabc' })).includes('On-chain gas on X Layer is free'), chain);
  }
  assert.equal(funding.fundingNoticeCommand({ currency: 'USDT', shortfall: '1', depositAddress: '0xabc', available: '', required: '2' }, 'task-payment'),
    'onchainos agent funding-notice --chain XLayer --currency USDT --shortfall 1 --deposit-address 0xabc --required 2 --reason task-payment --format json');
  assert.equal(funding.fundingNoticeCommand({ currency: 'USDT', shortfall: '1' }, 'task-payment'), undefined);
});

// ── misc pure helpers ────────────────────────────────────────────────────

test('dispute upload: mime table', () => {
  assert.equal(upload.mimeForExt('png'), 'image/png');
  assert.equal(upload.mimeForExt('md'), 'text/plain');
  assert.equal(upload.mimeForExt('exe'), 'application/octet-stream');
});

test('home: task_state_dir joins like Rust PathBuf::join (absolute / rooted job ids replace the base)', async () => {
  const h = await import(`${LIB}_home.mjs`);
  const { join: pj } = await import('node:path');
  assert.equal(h.taskStateDir('0xab'), pj(HOME, 'task', '0xab'));
  if (process.platform === 'win32') {
    assert.equal(h.rustJoin('C:\\home\\task', 'D:\\abs'), 'D:\\abs');
    assert.equal(h.rustJoin('C:\\home\\task', '\\rooted'), 'C:\\rooted');
    assert.equal(h.rustJoin('C:\\home\\task', 'D:rel'), 'D:rel');
    assert.equal(h.rustJoin('C:\\home\\task', '\\\\srv\\share\\x'), '\\\\srv\\share\\x');
    assert.equal(h.rustJoin('\\\\srv\\share\\home', '\\x'), '\\\\srv\\share\\x');
    assert.equal(h.rustJoin('C:\\home\\task', 'job'), 'C:\\home\\task\\job');
  } else {
    assert.equal(h.rustJoin('/home/task', '/abs'), '/abs');
    assert.equal(h.rustJoin('/home/task', 'job'), '/home/task/job');
  }
});

test('rust helpers: {:.1} rounding, strict base64, Debug strings', () => {
  assert.equal(rs.fixed1Ratio(1, 4), '0.2');
  assert.equal(rs.fixed1Ratio(3, 4), '0.8');
  assert.throws(() => rs.b64StdDecode('YQ'));
  assert.equal(Buffer.from(rs.b64StdDecode('YQ==')).toString(), 'a');
  assert.equal(rs.rustDebugStr('a"b\n'), '"a\\"b\\n"');
});

// ── differential sequences against the upstream binary (verifier) ───────
// Single-command parity cases start from a fresh home, so they never reach list / pick /
// cancel / resolve with a populated pending-decisions queue, deliverable listings with
// entries, or session-cleanup draining a queue. These tests replay one argv sequence
// against the upstream 4.6.3 binary and lite in two isolated homes (and isolated cwds —
// `task-deliverable-save` MOVES its source file) and compare exit code, stdout and every
// state file after each step. Queue mode is forced (CLAUDECODE / CODEX_THREAD_ID cleared):
// the parity runner inherits CLAUDECODE=1 from a Claude Code session, which silently puts
// pending-decisions-v2 into CLI mode. Local-only commands: no request reaches any API
// (the upstream build's origin is the loopback parity proxy; lite is pointed at a dead port).
{
  const { spawnSync } = await import('node:child_process');
  const { readdirSync, statSync, writeFileSync } = await import('node:fs');
  const { relative } = await import('node:path');
  const ROOT = join(import.meta.dirname, '..', '..');
  const UP = join(ROOT, '.cache', 'bin', process.platform === 'win32' ? 'onchainos-4.6.3-proxy.exe' : 'onchainos-4.6.3-proxy');
  const LITE = join(ROOT, 'skill', 'onchainos-lite', 'bin', 'ocl.mjs');
  const skip = existsSync(UP) ? false : 'upstream binary not built (.cache/bin)';
  const BS = String.fromCharCode(92);
  const J1 = `0x${'ab'.repeat(32)}`, J2 = `0x${'cd'.repeat(32)}`, J3 = `0x${'ef'.repeat(32)}`;
  const REFUND_B64 = 'eyJzZXJ2aWNlTmFtZSI6IlJlcG9ydCBzZXJ2aWNlIiwidGFza1R5cGUiOiJPbmUtdGltZSIsImFtb3VudCI6IjUiLCJ0b2tlblN5bWJvbCI6IlVTRFQiLCJyZXNwb25zZURlYWRsaW5lIjo0MTAyNDQ0ODAwfQ';
  const NL = `${BS}n`;   // the literal two-char `\n` escape the CLI expands
  const pv = (...a) => ['agent', 'pending-decisions-v2', ...a];
  const snapshot = (dir) => {
    const out = {};
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else { const rel = relative(dir, p).split(BS).join('/'); if (!/audit\.jsonl$/.test(rel)) out[rel] = readFileSync(p, 'utf8'); }
      }
    };
    walk(dir);
    return out;
  };
  const norm = (s, dirs) => {
    let t = String(s);
    for (const d of dirs) for (const v of [d.split(BS).join(BS + BS), d, d.split(BS).join('/')]) t = t.split(v).join('<DIR>');
    return t.replace(/_\d{8}_\d{9}\./g, '_<STAMP>.').replace(/onchainos-funding-qr-\d+-\d+/g, '<QR>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, '<TS>');
  };
  const runSequence = (steps, extraEnv = {}) => {
    const side = (label) => ({ home: mkdtempSync(join(tmpdir(), `ocl-seq-${label}-h-`)), cwd: mkdtempSync(join(tmpdir(), `ocl-seq-${label}-c-`)) });
    const up = side('up'), lite = side('lite');
    const env = { ...process.env, PATH: NOBIN, Path: NOBIN, NO_COLOR: '1', ONCHAINOS_NO_BROWSER: '1', CLAUDECODE: '', CODEX_THREAD_ID: '', OCL_BASE_URL: 'http://127.0.0.1:9', ...extraEnv };
    try {
      for (const [i, argv] of steps.entries()) {
        for (const s of [up, lite]) for (const n of ['a.md', 'b.txt', 'c.png']) writeFileSync(join(s.cwd, n), `content of ${n}`);
        const u = spawnSync(UP, argv, { env: { ...env, ONCHAINOS_HOME: up.home }, cwd: up.cwd, encoding: 'utf8' });
        const l = spawnSync(process.execPath, [LITE, ...argv], { env: { ...env, ONCHAINOS_HOME: lite.home, OCL_HOME: lite.home }, cwd: lite.cwd, encoding: 'utf8' });
        const view = (r, s) => ({ exit: r.status, stdout: norm(r.stdout, [s.home, s.cwd]),
          home: Object.fromEntries(Object.entries(snapshot(s.home)).map(([k, v]) => [norm(k, [s.home]), norm(v, [s.home, s.cwd])]).sort()) });
        assert.deepEqual(view(l, lite), view(u, up), `step ${i}: ${argv.slice(1).join(' ')}\nlite stderr: ${String(l.stderr).slice(0, 800)}`);
      }
    } finally {
      for (const s of [up, lite]) for (const d of [s.home, s.cwd]) rmSync(d, { recursive: true, force: true });
    }
  };

  test('differential: pending-decisions-v2 queue lifecycle (request, list, pick, resolve, cancel)', { skip, timeout: 300000 }, () => {
    runSequence([
      pv('request', '--job-id', J1, '--role', 'user', '--agent-id', '1001', '--to-agent-id', '2002', '--list-label', '[Decision 0xabab…abab] price decision', '--user-content', `Accept the quote?${NL}A) yes B) no`, '--source-event', 'negotiate_reply'),
      pv('request-prompt', '--job-id', J2, '--role', 'asp', '--agent-id', '2002', '--list-label', 'Refund req', '--user-content', 'Refund?', '--source-event', 'job_rejected', '--refund-display-b64', REFUND_B64),
      pv('request', '--job-id', J3, '--role', 'user', '--agent-id', '1001', '--list-label', 'Third', '--user-content', 'Pick one', '--source-event', 'job_submitted'),
      pv('list'), pv('list', '--format', 'json'), pv('list', '--scope', 'refund'), pv('list', '--scope', 'refund', '--format', 'json'),
      pv('pick', '--index', '2'), pv('list'), pv('pick', '--index', '9'), pv('pick', '--job-id', J2),
      pv('resolve', '--user-reply', 'B because late'), pv('list', '--format', 'json'),
      pv('cancel', '--index', '2'), pv('list'), pv('resolve', '--user-reply', 'A'), pv('list'),
      pv('cancel', '--index', '1'), pv('list', '--format', 'json'),
    ]);
  });

  test('differential: deliverables save/list/search and session-cleanup draining the queue', { skip, timeout: 300000 }, () => {
    runSequence([
      ['agent', 'task-deliverable-save', '--job-id', J1, '--role', 'user', '--file', 'a.md', '--title', 'Market report', '--short-id', '0xabab…abab', '--token-symbol', 'USDT', '--token-amount', '5'],
      ['agent', 'task-deliverable-save', '--job-id', J1, '--role', 'user', '--file', 'b.txt', '--title', 'Renamed title', '--short-id', 'x', '--deliverable-type', 'text'],
      ['agent', 'task-deliverable-save', '--job-id', J2, '--role', 'asp', '--file', 'c.png', '--title', '', '--short-id', 's', '--deliverable-type', 'image', '--file-key', 'fk', '--counterparty-agent-id', '1001', '--counterparty-name', 'Bob'],
      ['agent', 'task-deliverable-list'], ['agent', 'task-deliverable-list', '--role', 'asp'], ['agent', 'task-deliverable-list', '--search', 'MARKET', '--role', 'user'],
      ['agent', 'task-deliverable-list', '--search', 'cdcd'], ['agent', 'task-deliverable-list', '--job-id', J1], ['agent', 'task-deliverable-list', '--job-id', J2, '--role', 'asp'],
      ['agent', 'cache-notify', '--job-id', J1, '--event-key', 'job_completed_escrow', '--content', `Done ✓${NL}line2`],
      ['agent', 'cache-rating', '--job-id', J1, '--score', '4.50', '--comment', 'solid work'],
      ['agent', 'next-action', '--agentId', '1', '--role', 'user', '--message', `{"event":"job_submitted","jobId":"${J1}"}`],
      pv('request', '--job-id', J1, '--role', 'user', '--agent-id', '1001', '--list-label', 'L1', '--user-content', 'c1', '--source-event', 'negotiate_reply'),
      pv('request', '--job-id', J2, '--role', 'asp', '--agent-id', '2002', '--list-label', 'L2', '--user-content', 'c2', '--source-event', 'negotiate_reply'),
      pv('request', '--job-id', J1, '--role', 'asp', '--agent-id', '2002', '--list-label', 'L3', '--user-content', 'c3'),
      ['agent', 'session-cleanup', '--job-id', J1], pv('list', '--format', 'json'),
      ['agent', 'session-cleanup', '--job-id', J2], pv('list'),
    ]);
  });

  // okx-a2a success paths. `okx-a2a.exe` is a renamed copy of cmd.exe (exit 0, banner on stdout
  // with a null stdin) for the direct `Command::new("okx-a2a")` calls (user notify / decision
  // request / session send|delete); `okx-a2a.cmd` answers the `cmd /C` npm-shim calls (--version,
  // doctor --json). Windows only: elsewhere both would need a different fake.
  const winSkip = skip || (process.platform !== 'win32' ? 'fake okx-a2a uses cmd.exe' : false);
  const withFakeOkxA2a = (fn) => {
    const bin = mkdtempSync(join(tmpdir(), 'ocl-fake-a2a-'));
    try {
      writeFileSync(join(bin, 'okx-a2a.exe'), readFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')));
      writeFileSync(join(bin, 'okx-a2a.cmd'), '@echo off\r\nif "%1"=="--version" (echo 9.9.9 & exit /b 0)\r\nif "%1"=="doctor" (echo {"ready":false,"userMessage":"Hermes plugin","nextActions":[{"why":"restart","command":"/restart"},{"command":"x","optional":true}]} & exit /b 0)\r\nexit /b 0\r\n');
      const path = `${bin};${join(process.env.SystemRoot || 'C:\\Windows', 'System32')}`;
      fn({ PATH: path, Path: path });
    } finally { rmSync(bin, { recursive: true, force: true }); }
  };
  const fakeSteps = [
    ['agent', 'user-notify', '--content', `hi${NL}there`],
    ['agent', 'user-notify', '--content', 'hi', '--image-path', 'a.md'],
    ['agent', 'funding-notice', '--chain', 'XLayer', '--currency', 'USDT', '--shortfall', '1', '--deposit-address', '0x1234567890abcdef1234567890abcdef12345678', '--notify-user', '--content', 'pay'],
    pv('request', '--job-id', J1, '--role', 'user', '--agent-id', '1001', '--to-agent-id', '2002', '--list-label', 'L1', '--user-content', 'Accept?', '--source-event', 'negotiate_reply'),
    pv('request-prompt', '--job-id', J2, '--role', 'asp', '--agent-id', '2002', '--list-label', 'Refund', '--user-content', 'Refund?', '--source-event', 'job_rejected', '--refund-display-b64', REFUND_B64),
    pv('list'), pv('resolve', '--user-reply', 'yes please'), pv('list', '--format', 'json'), pv('pick', '--index', '1'), pv('resolve', '--user-reply', 'B too late'),
    pv('resolve-with-sessionkey', '--user-reply', 'A', '--job-id', J2, '--role', 'asp', '--agent-id', '2002', '--source-event', 'job_rejected'),
    pv('resolve-prompt', '--user-reply', 'ok', '--job-id', J1, '--role', 'user', '--agent-id', '1001', '--to-agent-id', '2002', '--source-event', 'negotiate_reply'),
    ['agent', 'session-cleanup', '--job-id', J1],
    ['agent', 'communication-check'],
  ];
  test('differential: okx-a2a success paths, queue mode (notify, relay, cleanup, doctor verdict)', { skip: winSkip, timeout: 300000 }, () => {
    withFakeOkxA2a((env) => runSequence(fakeSteps, env));
  });
  test('differential: okx-a2a success paths, CLI mode (CLAUDECODE=1)', { skip: winSkip, timeout: 300000 }, () => {
    withFakeOkxA2a((env) => runSequence(fakeSteps, { ...env, CLAUDECODE: '1' }));
  });
}
