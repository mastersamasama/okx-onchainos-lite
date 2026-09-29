// Unit tests for the ASP / evaluator partition (lib/agent/task/{asp,evaluator}/**) — oracles are
// the upstream Rust unit tests in task/asp/*.rs and task/evaluator/*.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from '../../skill/onchainos-lite/lib/core/json.mjs';
import * as decimalStr from '../../skill/onchainos-lite/lib/agent/task/evaluator/decimal-str.mjs';
import { formatFractionalUnit, STAKING_CONFIG, MY_STAKE } from '../../skill/onchainos-lite/lib/agent/task/evaluator/staking-types.mjs';
import { fromValue } from '../../skill/onchainos-lite/lib/core/serde.mjs';
import { unescapeReason } from '../../skill/onchainos-lite/lib/agent/task/evaluator/commit.mjs';
import { gateReason, decodeDisputeStatusResponse, evaluatorTaskIsTerminal } from '../../skill/onchainos-lite/lib/agent/task/evaluator/dispute-status.mjs';
import { notifyBlock, notifyBlockLines, i64Field, displayField as evalDisplayField, hoursLeftText, minutesLeftText, terminalSessionHint, generateNextAction as evalNext } from '../../skill/onchainos-lite/lib/agent/task/evaluator/flow.mjs';
import { buildReasonHandoff, buildSubscriptionReasonHandoff, withSaBatchTxFlag, ARBITRATION_REASON_CONTEXT } from '../../skill/onchainos-lite/lib/agent/task/asp/dispute-raise.mjs';
import { decodeReasonInput } from '../../skill/onchainos-lite/lib/agent/task/asp/dispute-confirm.mjs';
import { utf8ErrorText } from '../../skill/onchainos-lite/lib/core/rs/str.mjs';
import { SubscriptionDetail, SubStatus, Routing, BUFFER_WINDOW_SECS } from '../../skill/onchainos-lite/lib/agent/task/asp/subscription.mjs';
import { isLongText } from '../../skill/onchainos-lite/lib/agent/task/asp/deliver.mjs';
import * as content from '../../skill/onchainos-lite/lib/agent/task/asp/content.mjs';
import * as notification from '../../skill/onchainos-lite/lib/agent/task/asp/v2/notification.mjs';
import { handle as subComplete } from '../../skill/onchainos-lite/lib/agent/task/asp/v2/sub-complete-notify.mjs';
import { resultFromTaskDetail, preserveExistingProviderRating } from '../../skill/onchainos-lite/lib/agent/task/asp/v2/job-completed.mjs';
import { DecisionKind, validateInputs, validateResponse, detailStatus, alreadyAcceptedResult, broadcastSubmittedResult, decisionPath } from '../../skill/onchainos-lite/lib/agent/task/asp/provider-decision.mjs';
import {
  subscriptionListPath, oneTimeListPath, buildListResult, buildDetailResult, dateOnly, TaskKind, isZeroAmount, boolFromKeys, integerFromKeys, subscriptionStatusCode,
  buildProviderArbitrationDetailResult,
} from '../../skill/onchainos-lite/lib/agent/task/asp/task-query.mjs';
import { taskParamsRequestCommand, rejectExpireTime, generateNextAction as aspNext, displayNotify } from '../../skill/onchainos-lite/lib/agent/task/asp/flow.mjs';
import { PreFetchedTaskContext } from '../../skill/onchainos-lite/lib/agent/task/common/index.mjs';

// ── decimal_str.rs tests ──
test('decimal_str: sub has no fp artifact', () => { assert.equal(decimalStr.sub('0.0012', '0.0002'), '0.001'); });
test('decimal_str: cmp handles uneven precision', () => {
  assert.equal(decimalStr.cmp('0.001', '0.0010'), 0);
  assert.equal(decimalStr.cmp('0.0012', '0.001'), 1);
  assert.equal(decimalStr.cmp('0.0009', '0.001'), -1);
});
test('decimal_str: add / integers / mixed precision / trailing zeros', () => {
  assert.equal(decimalStr.add('0.0012', '0.0008'), '0.002');
  assert.equal(decimalStr.add('1', '0.5'), '1.5');
  assert.equal(decimalStr.add('0', '0'), '0');
  assert.equal(decimalStr.sub('100', '30'), '70');
  assert.equal(decimalStr.add('100', '30'), '130');
  assert.equal(decimalStr.cmp('100', '30'), 1);
  assert.equal(decimalStr.sub('10.5', '0.0001'), '10.4999');
  assert.equal(decimalStr.add('10.5', '0.0001'), '10.5001');
  assert.equal(decimalStr.sub('0.10', '0.05'), '0.05');
  assert.equal(decimalStr.add('0.5', '0.5'), '1');
  assert.equal(decimalStr.add('.5', '1.'), '1.5');
});
test('decimal_str: errors', () => {
  assert.throws(() => decimalStr.sub('0.001', '0.002'), { message: 'decimal subtraction underflow: "0.001" - "0.002"' });
  assert.throws(() => decimalStr.cmp('', '0'), { message: 'decimal string is empty' });
  assert.throws(() => decimalStr.cmp('abc', '0'), { message: 'invalid decimal (non-digit in integer part): "abc"' });
  assert.throws(() => decimalStr.cmp(' 1.2.3 ', '0'), { message: 'invalid decimal (non-digit in fractional part): "1.2.3"' });
  assert.throws(() => decimalStr.cmp('-1', '0'), { message: 'invalid decimal (non-digit in integer part): "-1"' });
  assert.throws(() => decimalStr.cmp('9'.repeat(40), '0'), /decimal exceeds u128 range/);
});

// ── staking_types.rs ──
test('format_fractional_unit', () => {
  assert.equal(formatFractionalUnit(604800, 86400), '7');
  assert.equal(formatFractionalUnit(64800, 3600), '18');
  assert.equal(formatFractionalUnit(21600, 3600), '6');
  assert.equal(formatFractionalUnit(86400, 3600), '24');
  assert.equal(formatFractionalUnit(0, 3600), '0');
  assert.equal(formatFractionalUnit(5400, 3600), '1.5');
  assert.equal(formatFractionalUnit(129600, 86400), '1.5');
  assert.equal(formatFractionalUnit(18, 3600), '0.01');
  assert.equal(formatFractionalUnit(36, 86400), '0.0004');
  assert.equal(formatFractionalUnit(1, 86400), '0');
  assert.equal(formatFractionalUnit(4000, 3600), '1.11');
});
test('StakingConfig / MyStake serde', () => {
  const cfg = { minCumulativeStakeOkb: '0.001', partialUnstakeMinRetainOkb: '0.001', unstakeCooldownSeconds: '604800', arbitrationFeeBps: '5%',
    commitPhaseSeconds: '64800', revealPhaseSeconds: '21600', slashMinorityBps: '1%', slashTimeoutBps: '0.3%', slashedCooldownSeconds: '86400' };
  assert.equal(fromValue(cfg, STAKING_CONFIG).unstakeCooldownSeconds, 604800);
  assert.throws(() => fromValue({ ...cfg, commitPhaseSeconds: 64800 }, STAKING_CONFIG), { message: 'invalid type: integer `64800`, expected a string' });
  assert.throws(() => fromValue({ ...cfg, revealPhaseSeconds: '6h' }, STAKING_CONFIG), { message: 'expected u64 string, got "6h": invalid digit found in string' });
  assert.throws(() => fromValue({ arbitrationFeeBps: '5%' }, STAKING_CONFIG), { message: 'missing field `minCumulativeStakeOkb`' });
  const m = fromValue({ voterAddress: '0x1', agentId: '1', activeStake: '1', pendingUnstake: '0', validStake: '1', activeDisputes: '0' }, MY_STAKE);
  assert.deepEqual([m.cooldownEndsAt, m.unstakeAvailableAt, m.registered], [0, 0, false]);
  assert.throws(() => fromValue({ voterAddress: '0x1', agentId: '1', activeStake: '1', pendingUnstake: '0', validStake: '1', activeDisputes: 0 }, MY_STAKE),
    { message: 'invalid type: integer `0`, expected a string' });
});

// ── commit.rs tests ──
test('unescape_reason', () => {
  assert.equal(unescapeReason('line1\\nline2'), 'line1\nline2');
  assert.equal(unescapeReason('col1\\tcol2'), 'col1\tcol2');
  assert.equal(unescapeReason('dos\\r\\nstyle'), 'dos\r\nstyle');
  assert.equal(unescapeReason('path\\\\to\\\\file'), 'path\\to\\file');
  assert.equal(unescapeReason('He said \\"hi\\"'), 'He said "hi"');
  assert.equal(unescapeReason('foo\\qbar'), 'foo\\qbar');
  assert.equal(unescapeReason('foo\\'), 'foo\\');
  const out = unescapeReason('Verdict\\n\\nJob ID: 0xabc\\nvote: 1\\nReasoning: per #3, client submitted no evidence.');
  assert.ok(out.startsWith('Verdict\n\n') && out.includes('\nvote: 1\n') && out.endsWith('no evidence.') && !out.includes('\\n'));
});

// ── dispute_status.rs ──
test('dispute status decode + gates', () => {
  const base = { jobId: 'j', currentRound: 1, selectedVoter: {}, taskStatus: 4, disputeStatus: 1 };
  const s = decodeDisputeStatusResponse(base);
  assert.equal(s.disputeRoundStatus, 1);
  assert.equal(gateReason(s, '1'), undefined);
  assert.equal(gateReason(s, '+1'), undefined);
  assert.equal(gateReason(s, 'abc'), '--round-num cannot be parsed as integer: "abc" (invalid digit found in string)');
  assert.equal(gateReason(s, ''), '--round-num cannot be parsed as integer: "" (cannot parse integer from empty string)');
  assert.equal(gateReason(s, '2'), 'round mismatch: envelope round_num=2 != on-chain currentRound=1 (stale envelope)');
  assert.match(gateReason(decodeDisputeStatusResponse({ ...base, taskStatus: 8 }), '1'), /^taskStatus=8 \(expired\) is terminal/);
  assert.match(gateReason(decodeDisputeStatusResponse({ ...base, disputeStatus: 2 }), '1'), /^disputeStatus=2 \(reveal_phase\) is not commit_phase/);
  assert.match(gateReason(decodeDisputeStatusResponse({ ...base, selectedVoter: null }), '1'), /^selectedVoter=null/);
  assert.throws(() => decodeDisputeStatusResponse({ taskStatus: 4 }), { message: 'missing field `jobId`' });
  assert.throws(() => decodeDisputeStatusResponse({ jobId: 'j', taskStatus: null }), { message: 'invalid type: null, expected i32' });
  for (const st of ['completed', 'close', 'expired', 'failed']) assert.ok(evaluatorTaskIsTerminal(st));
  for (const st of ['created', 'accepted', 'submitted', 'rejected', 'disputed']) assert.ok(!evaluatorTaskIsTerminal(st));
});

// ── evaluator flow helpers ──
test('evaluator flow helpers', () => {
  assert.equal(notifyBlock('X'), "Run `onchainos agent user-notify` to push the notification to the user. Translate the content below into the user's language first, then run:\n\n```bash\nonchainos agent user-notify --content \"<localized content>\"\n```\n\nCanonical English content:\n    X\n");
  assert.ok(notifyBlockLines(['a', 'b']).endsWith('Canonical English content:\n    a\n    b\n'));
  assert.equal(i64Field({ a: '12', b: 3, c: 1.5, d: ' 4' }, 'a'), 12);
  assert.equal(i64Field({ c: parse('1.5') }, 'c'), undefined);
  assert.equal(i64Field({ d: ' 4' }, 'd'), undefined);
  assert.equal(evalDisplayField({ a: parse('12.50') }, 'a'), '12.5');
  assert.equal(hoursLeftText(7200 + 100, 100), '2 hours');
  assert.equal(hoursLeftText(150, 100), 'less than 1 hour');
  assert.equal(hoursLeftText(100, 100), undefined);
  assert.equal(minutesLeftText(100 + 59, 100), 'less than 1 minute remaining');
  assert.equal(minutesLeftText(100 + 120, 100), '2 minutes remaining');
  assert.ok(terminalSessionHint('j').startsWith('\n**Terminal wrap-up'));
});
test('evaluator next-action (no HTTP events)', async () => {
  assert.equal(await evalNext('j', 'weird', '1', {}), '[unknown event=weird at jobId=j ignored.\nDo not pull context; do not guess other notifications.\n');
  const out = await evalNext('j', 'dispute_resolved', '1', { hasCommit: 0, jobTitle: 'T' });
  assert.ok(out.includes('⚖️ You missed [Commit] for task [T] evaluation') && out.includes('Missed-commit branch ends this turn'));
  const won = await evalNext('j', 'dispute_resolved', '1', { vote: 1, jobStatus: 'complete' });
  assert.ok(won.includes('Your vote: backed ASP ✓ aligned with majority') && won.includes('hasClaimable: yes'));
  const lost = await evalNext('j', 'dispute_resolved', '1', { vote: 0, jobStatus: 'complete', slashMinorityBps: '1%' });
  assert.ok(lost.includes('✗ opposed majority') && lost.includes('• Stake slashed 1%'));
});

// ── dispute_raise.rs tests ──
test('reason handoff (one-time + subscription)', () => {
  const reason = 'The delivered output missed the requested scope; $(touch /tmp/nope)';
  const lines = buildReasonHandoff('job-1', 'asp-1', reason).split('\n');
  assert.equal(lines[0], ARBITRATION_REASON_CONTEXT);
  const p = JSON.parse(lines[1]);
  assert.deepEqual([p.jobId, p.providerAgentId, p.reason, p.taskType, p.resumeEvent, p.version], ['job-1', 'asp-1', reason, 'one_time', 'job_disputed', 1]);
  assert.match(p.reasonB64, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(p.reasonB64, 'base64url').toString('utf8'), reason);
  assert.equal(lines[1], stringify(p));
  assert.equal(lines[2], "Keep this exact reason in the current task conversation and end this turn. When the matching job_disputed event arrives, include it as the ASP's evaluation reason in the evidence upload.");
  const r2 = 'keep + / = and a newline\nsecond line';
  const s = buildSubscriptionReasonHandoff('sub-1', 'asp-1', r2);
  const q = JSON.parse(s.split('\n')[1]);
  assert.deepEqual([q.taskType, q.resumeEvent, q.reason], ['subscription', 'sub_asp_dispute', r2]);
  assert.ok(s.endsWith('When the matching sub_asp_dispute event arrives, include it as the ASP\'s evaluation reason in the evidence upload.'));
});
test('with_sa_batch_tx_flag', () => {
  const uop = { extraData: { coinAmount: '0', inputData: '0x1234' } };
  const f = withSaBatchTxFlag(uop);
  assert.deepEqual(f.extraData, { coinAmount: '0', inputData: '0x1234', isSaBatchTx: true });
  assert.equal(uop.extraData.isSaBatchTx, undefined);
  assert.throws(() => withSaBatchTxFlag({}), { message: 'approveAndCreateDispute response missing object uopData.extraData' });
  assert.throws(() => withSaBatchTxFlag(null), { message: 'approveAndCreateDispute response missing object uopData.extraData' });
});

// ── dispute_confirm.rs tests ──
test('decode_reason_input', () => {
  const reason = 'The delivery met the agreed requirements';
  assert.equal(decodeReasonInput(undefined, Buffer.from(reason).toString('base64url')), reason);
  assert.throws(() => decodeReasonInput(undefined, undefined));
  assert.throws(() => decodeReasonInput('reason', 'cmVhc29u'));
  assert.throws(() => decodeReasonInput(undefined, '%%%invalid%%%'), /^Error: --reason-b64 is not valid URL-safe base64: Invalid symbol 37, offset \d+\.$/);
  assert.throws(() => decodeReasonInput(undefined, '_w'), { message: '--reason-b64 does not contain UTF-8 text: invalid utf-8 sequence of 1 bytes from index 0' });
});
test('utf8 error text (Rust Utf8Error)', () => {
  assert.equal(utf8ErrorText(Buffer.from('ok ✓')), undefined);
  assert.equal(utf8ErrorText(Buffer.from([0x61, 0xff])), 'invalid utf-8 sequence of 1 bytes from index 1');
  assert.equal(utf8ErrorText(Buffer.from([0xe2, 0x9c])), 'incomplete utf-8 byte sequence from index 0');
  assert.equal(utf8ErrorText(Buffer.from([0xe2, 0x9c, 0x41])), 'invalid utf-8 sequence of 2 bytes from index 0');
  assert.equal(utf8ErrorText(Buffer.from([0xf0, 0x9f, 0x98, 0x41])), 'invalid utf-8 sequence of 3 bytes from index 0');
  assert.equal(utf8ErrorText(Buffer.from([0xed, 0xa0, 0x80])), 'invalid utf-8 sequence of 1 bytes from index 0');
});

// ── subscription.rs tests ──
const detail = (jobType, status, bufferEnd) => new SubscriptionDetail({ jobType, status: SubStatus.fromInt(status), subEndTime: undefined, subBufferEndTime: bufferEnd });
test('subscription liveness', () => {
  for (const c of [-1, 0, 1, 3, 4, 6, 7, 8, 9, 999]) assert.equal(SubStatus.code(SubStatus.fromInt(c)), c);
  assert.ok(SubStatus.isActive(1) && !SubStatus.isActive(3) && !SubStatus.isActive(100));
  assert.ok(detail(1, 1).isSubscription() && !detail(0, 1).isSubscription());
  assert.equal(detail(1, 1, 2000).liveness(1000), Routing.Active);
  assert.equal(detail(1, 1, undefined).liveness(1000), Routing.Active);
  assert.equal(detail(1, 1, 500).liveness(1000), Routing.Ended);
  const d = detail(1, 1, undefined); d.subEndTime = 1000;
  assert.equal(d.liveness(1000 + BUFFER_WINDOW_SECS + 1), Routing.Ended);
  assert.equal(d.liveness(1010), Routing.Active);
  for (const st of [-1, 0, 3, 4, 6, 7, 8, 9, 100]) assert.equal(detail(1, st, 9999).liveness(1000), Routing.Ended);
  const p = SubscriptionDetail.fromJson({ jobType: '1', status: '1', copyTrade: '1', subEndTime: '1783868715', subBufferEndTime: '1786633515' });
  assert.ok(p.isSubscription() && SubStatus.isActive(p.status));
  assert.equal(p.subBufferEndTime, 1786633515);
  assert.ok(SubStatus.isActive(SubscriptionDetail.fromJson({ jobType: 1, subStatus: 1 }).status));
  const d2 = SubscriptionDetail.fromJson({ jobType: 1 });
  assert.equal(d2.status, -2);
  assert.equal(d2.liveness(1000), Routing.Ended);
});
test('deliver long text threshold counts Unicode characters', () => {
  assert.ok(!isLongText('你'.repeat(500)) && isLongText('你'.repeat(501)));
  assert.ok(!isLongText('a'.repeat(500)) && isLongText('a'.repeat(501)));
});

// ── content.rs tests ──
test('content job notification copy', () => {
  assert.equal(content.subscriptionJobAspAcceptExpireAspNotify('BTC Signals', 'job-1', '12.34', 'USDT', false, true),
    '[Job Expired] You did not process BTC Signals within 3 hours, so the job expired.\n\nJob ID: job-1\nJob status: Expired\n\nThe subscription did not begin. The escrowed amount of 12.34 USDT will be returned to the User Agent’s wallet. No further action is required.');
  assert.equal(content.subscriptionJobAspAcceptExpireAspNotify('BTC Signals', 'job-1', '12.34', 'USDT', true, false),
    '[Job Expired] You did not process BTC Signals within 3 hours, so the job expired.\n\nJob ID: job-1\nJob status: Expired\n\nNeither the subscription nor the free trial began. No further action is required.');
  assert.equal(content.subscriptionJobAspRejectClosedAspNotify('BTC Signals', 'job-1', 'capacity unavailable'), '[Task Declined] You have declined BTC Signals.\nJob ID: job-1\nReason: capacity unavailable');
  assert.equal(content.subscriptionJobAspRejectExpireAspNotify('BTC Signals', 'job-1', '12.34', 'USDT', 1700000000),
    '[Automatic Refund Processing] You did not respond to the refund request for BTC Signals by the deadline. 12.34 USDT will be returned to the User Agent’s wallet.\n\nJob ID: job-1\nResponse deadline: 2023-11-14 22:13 UTC\nJob status: Failed\nNo further service delivery is required.');
  assert.equal(content.subAspClaimNotifyAspNotify('BTC Signals', 'job-1', '12.34', 'USDT', '0xreceive'),
    '[Income Collected] The system has automatically collected subscription income of 12.34 USDT for BTC Signals. Please monitor your wallet balance.\n\nJob ID: job-1\nTransaction: 0xreceive');
  assert.equal(content.regularJobAspAcceptExpireAspNotify('One-off analysis', 'job-2'), '[Job Expired] You did not process One-off analysis within 3 hours, so the job expired.\n\nJob ID: job-2\nJob status: Expired');
  assert.equal(content.regularJobAspRejectClosedAspNotify('One-off analysis', 'job-2', 'policy'), '[Job Declined] You have declined One-off analysis.\n\nJob ID: job-2\nReason: policy\nJob status: Closed');
  assert.equal(content.regularJobAspRejectExpireAspNotify('One-off analysis', 'job-2', '5', 'USDT', 1700000000, true),
    '[Automatic Refund Processing] You did not respond to the refund request for One-off analysis by the deadline. 5 USDT will be returned to the User Agent’s wallet.\n\nJob ID: job-2\nResponse deadline: 2023-11-14 22:13 UTC\nJob status: Failed');
  assert.equal(content.regularJobAspRejectExpireAspNotify('One-off analysis', 'job-3', '0', 'USDT', 1700000000, false),
    '[Refund Response Timed Out] You did not respond to the refund request for One-off analysis by the deadline. No charges were incurred, so no refund is required.\n\nJob ID: job-3\nResponse deadline: 2023-11-14 22:13 UTC\nJob status: Failed');
  assert.equal(content.fmtEpoch(1700000000000), '2023-11-14 22:13 UTC');
  assert.equal(content.fmtEpoch(0), undefined);
});
test('content subscription copy', () => {
  const prompt = content.submitDeadlineWarnUserPrompt('abc123');
  assert.ok(prompt.includes('the backend automatically returns any escrowed funds') && prompt.includes('No client-side refund claim is required'));
  const out = content.subAspSelectedAspNotify('My Sub', 'agent-buyer-1', 'job-1', '3.00', 'USDT', 1700000000, 1700500000);
  assert.ok(out.startsWith('[New Subscription]') && out.includes('new subscriber for "My Sub"') && out.includes('Buyer: agent-buyer-1.') && out.includes('payment received: 3.00 USDT'));
  assert.ok(content.subAspSelectedAspNotify('My Sub', undefined, 'job-1').includes('Job job-1. Please begin delivering the service.'));
  const selected = content.subAspSelectedAspNotify(undefined, undefined, 'job-1');
  const complete = content.subCompleteNotifyAspNotify(undefined, 'job-1');
  const closed = content.subCloseNotifyAspNotify(undefined, 'job-1');
  const failed = content.subFailedNotifyAspNotify(undefined, 'job-1');
  for (const o of [selected, complete, closed, failed]) assert.ok(!o.includes('<title>') && !o.includes('""'));
  assert.ok(selected.includes('You have a new subscriber.'));
  assert.ok(complete.includes("The user's subscription has completed all scheduled renewals"));
  assert.ok(closed.includes("The user's subscription has ended because the renewal charge failed"));
  assert.ok(failed.includes("The user's free trial failed to convert to a paid subscription"));
  const decl = content.subCloseNotifyAspNotify('My Sub', 'job-1', 'unsupported region');
  assert.ok(decl.includes('You declined the user\'s subscription to "My Sub"') && decl.includes('Reason: unsupported region') && !decl.includes('renewal charge failed'));
  assert.ok(!content.subCloseNotifyAspNotify('My Sub', 'job-1', '  ').includes('Reason:'));
  const trial = content.subAspSelectedTrialAspNotify('My Sub', 'agent-buyer-1', 'job-1', '0.0005', 'USDT', 1700000000, 1700500000);
  assert.ok(trial.startsWith('[New Trial Subscriber]') && !trial.includes('payment received') && trial.includes('0.0005 USDT will be charged on conversion at 2023-11-20'));
  assert.ok(content.jobRejectedUserDecisionPrompt('0xabc', undefined).endsWith('include your evaluation reason.'));
  assert.ok(content.jobRejectedUserDecisionPrompt('0xabc', Math.floor(Date.now() / 1000) + 86400).includes('⏰ Decision deadline: 1 day(s)'));
});

// ── v2 notification / sub_complete / job_completed ──
const ctx = (over) => PreFetchedTaskContext.fromApiResponse(over);
test('v2 notification builders', () => {
  const paid = JSON.parse(notification.jobAspAcceptExpire('job-1', ctx({ title: 'Audit', serviceName: 'Audit service', jobType: 0, paymentTokenAmount: '5', tokenSymbol: 'USDT', status: 8 }), undefined));
  assert.equal(paid.nextAction[0].id, 'notify_and_cleanup_subscription');
  assert.ok(paid.payload.notification.content.startsWith('[Job Expired] You did not process Audit service'));
  const stale = JSON.parse(notification.jobAspAcceptExpire('job-1', ctx({ jobType: 0, status: 1 }), undefined));
  assert.deepEqual(stale.payload.error.missingFields, ['status']);
  const noKind = JSON.parse(notification.jobDeliveryExpired('job-1', ctx({ status: 8 }), 'job_expired'));
  assert.deepEqual(noKind.payload.error.missingFields, ['jobType']);
  const subCtx = ctx({ jobType: 1, status: 8, paymentTokenAmount: 'x' }); subCtx.trialType = 0;
  assert.deepEqual(JSON.parse(notification.jobDeliveryExpired('job-1', subCtx, 'submit_expired')).payload.error.missingFields, ['tokenAmount']);
  const free = JSON.parse(notification.freeJobRejectedFailed('job-1', ctx({ title: 'Daily', jobType: 0, status: 9 }), { reason: 'bad' }));
  assert.equal(free.payload.statusLabel, 'Failed');
  assert.ok(free.payload.notification.content.startsWith('[onchainos:task-terminal] [Job Failed] Job job-1 (Daily)'));
  const claim = JSON.parse(notification.subAspClaimNotify('job-1', {}));
  assert.equal(claim.payload.notification.content.split('\n')[0], '[Income Collected] The system has automatically collected subscription income of 0  for job. Please monitor your wallet balance.');
  assert.equal(notification.paymentIsPaid(' 0.00 '), false);
  assert.equal(notification.paymentIsPaid('1.2.3'), undefined);
  assert.equal(notification.paymentIsPaid('.5'), undefined);
  assert.equal(notification.paymentIsPaid('0.1'), true);
});
test('sub_complete_notify handle', () => {
  const o = JSON.parse(subComplete('job-1', 'Service A', undefined));
  assert.equal(o.phase, 'subscription_completion');
  assert.equal(o.nextAction[0].params.jobId, 'job-1');
  assert.ok(o.payload.notification.content.includes('Service A'));
});
test('job_completed result', () => {
  const r = resultFromTaskDetail('job-1', '9001', { ok: { jobId: 'job-1', status: 6, title: 'Audit report', description: 'Audit', tokenAmount: '12', tokenSymbol: 'USDT', buyerAgentId: '5' } });
  assert.equal(r.reason, 'notification_and_rating_required');
  assert.equal(r.payload.rating.taskParameters, null);
  assert.ok(r.payload.ratingResultNotification.includes('Job Audit report (`job-1`)'));
  preserveExistingProviderRating(r, { ok: true });
  assert.equal(r.reason, 'notification_required');
  assert.equal(r.payload.ratingResultNotification, undefined);
  assert.equal(resultFromTaskDetail('job-1', '9', { err: new Error('x') }).reason, 'task_detail_unavailable');
  assert.equal(resultFromTaskDetail('job-1', '9', { ok: { jobId: 'job-2', status: 6 } }).reason, 'task_detail_job_id_mismatch');
  assert.equal(resultFromTaskDetail('job-1', '9', { ok: { jobId: 'job-1', status: 2 } }).reason, 'stale_task_status');
});

// ── provider_decision.rs tests ──
test('provider decisions', () => {
  for (const [kind, biz] of [[DecisionKind.AcceptJob, 203], [DecisionKind.DeclineJob, 202], [DecisionKind.AcceptSubscription, 205], [DecisionKind.DeclineSubscription, 206]]) {
    validateResponse('job-1', kind, { jobId: 'job-1', type: biz, uopData: {} });
    assert.deepEqual(broadcastSubmittedResult('job-1', kind, { txHash: '0x1' }).nextAction, []);
  }
  assert.equal(detailStatus(DecisionKind.AcceptJob, { status: 0 }), 0);
  assert.equal(detailStatus(DecisionKind.AcceptSubscription, { subStatus: 1 }), 1);
  for (const kind of [DecisionKind.AcceptJob, DecisionKind.AcceptSubscription]) {
    const r = alreadyAcceptedResult('job-1', kind);
    assert.deepEqual([r.decision, r.reason, r.payload.status], ['ready', 'already_accepted', 1]);
  }
  assert.throws(() => validateInputs('job-1', 'asp-1', DecisionKind.DeclineJob, ''));
  assert.throws(() => validateInputs('job-1', 'asp-1', DecisionKind.DeclineSubscription, '理'.repeat(513)), { message: '--reason exceeds 512 Unicode characters' });
  validateInputs('job-1', 'asp-1', DecisionKind.DeclineSubscription, 'out of scope');
  const c = { endpoint: (j, a) => `/priapi/v1/aieco/task/${j}/${a}`, subscribePath: (j) => `/priapi/v1/aieco/task/subscribe/${j}` };
  assert.equal(decisionPath(DecisionKind.AcceptJob, c, 'job-1'), '/priapi/v1/aieco/task/job-1/acceptJobByProvider');
  assert.equal(decisionPath(DecisionKind.DeclineSubscription, c, 'job-1'), '/priapi/v1/aieco/task/subscribe/job-1/declineSubscription');
  assert.throws(() => validateResponse('job-1', DecisionKind.AcceptJob, { jobId: 'job-1', type: 202, uopData: {} }), { message: 'acceptJobByProvider returned bizType 202, expected 203' });
});

// ── task_query.rs tests ──
test('task query list result', () => {
  const subscriptions = { total: 1, list: [{ jobId: 'sub-1', title: 'Daily Brief', buyerAgentName: 'Market Agent', buyerAgentId: '8415', providerAgentId: '9001', status: 1,
    serviceTokenAmount: '10', paymentTokenSymbol: 'USDT', periodIndex: 2, subStartTime: 1788192600, subEndTime: 1790784600, autoRenew: 1, testFlag: true, createTime: 1788192600 }] };
  const oneTime = { total: 1, list: [{ jobId: 'job-1', title: 'Risk Analysis', buyerAgentName: 'Research Agent', buyerAgentId: '5331', status: 0, tokenAmount: '0.1', tokenSymbol: 'USDT' }] };
  const r = buildListResult('9001', 1, 20, undefined, oneTime, subscriptions);
  const items = r.payload.items;
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].taskTypeLabel, items[0].testFlag, items[0].feeLabel, items[0].statusLabel, items[0].billingPeriodLabel, items[0].autoRenewLabel],
    ['Subscription Task', true, '10 USDT / month', 'Active', 'Billing Period 2', 'Enabled']);
  assert.equal(typeof items[0].nextChargeAt, 'string');
  assert.deepEqual([items[1].taskTypeLabel, items[1].feeLabel, items[1].billingPeriodLabel], ['One-time Task', '0.1 USDT / task', null]);
  assert.equal(r.payload.hasSubscriptionTasks, true);
  const subs2 = { total: 1, list: [{ jobId: 'sub-active', providerAgentId: '9001', status: 1 }, { jobId: 'sub-closed', providerAgentId: '9001', status: 7 }] };
  const accepted = buildListResult('9001', 1, 20, 'accepted', { total: 0, list: [] }, subs2);
  assert.deepEqual(accepted.payload.items.map((i) => i.jobId), ['sub-active']);
  assert.deepEqual([accepted.payload.total, accepted.payload.hasMore], [1, false]);
  assert.equal(buildListResult('9001', 1, 20, 'submitted', { total: 0, list: [] }, subs2).payload.items.length, 0);
  const page = (prefix, start, count, extra) => ({ total: 10, list: Array.from({ length: count }, (_, i) => ({ jobId: `${prefix}-${start + i}`, status: extra, providerAgentId: '9001' })) });
  const first = buildListResult('9001', 1, 3, undefined, page('task', 1, 3, 0), page('sub', 1, 3, 1));
  assert.deepEqual(first.payload.items.map((i) => i.jobId), ['sub-1', 'sub-2', 'sub-3', 'task-1', 'task-2', 'task-3']);
  assert.deepEqual([first.payload.total, first.payload.hasMore, first.payload.subscriptionHasMore], [20, true, true]);
  const fourth = buildListResult('9001', 4, 3, undefined, page('task', 10, 1, 0), page('sub', 10, 1, 1));
  assert.deepEqual([fourth.payload.items.length, fourth.payload.hasMore], [2, false]);
});
test('task query paths + scalar helpers', () => {
  assert.equal(subscriptionListPath(2, 3, undefined), '/priapi/v1/aieco/task/subscribe/my?page=2&pageSize=3&statusType=0');
  assert.equal(subscriptionListPath(2, 3, 'active'), '/priapi/v1/aieco/task/subscribe/my?page=2&pageSize=3&statusType=0&statusList=1');
  assert.equal(subscriptionListPath(2, 3, 'submitted'), undefined);
  assert.equal(oneTimeListPath(2, undefined), '/priapi/v1/aieco/task/my?page=2&page_size=20');
  assert.equal(oneTimeListPath(2, ' submitted '), '/priapi/v1/aieco/task/my?page=2&page_size=20&status=submitted');
  assert.ok(isZeroAmount('+0.00') && !isZeroAmount('') && !isZeroAmount('0.1'));
  assert.equal(boolFromKeys({ a: ' TRUE ' }, ['a']), true);
  assert.equal(boolFromKeys({ a: 0 }, ['a']), false);
  assert.equal(boolFromKeys({ a: 'yes' }, ['a']), undefined);
  assert.equal(integerFromKeys({ a: ' 12 ' }, ['a']), 12);
  assert.equal(subscriptionStatusCode(' Completed '), 6);
  assert.equal(subscriptionStatusCode('-1'), -1);
});
test('task query detail result', () => {
  const d = { jobId: 'sub-1', title: 'Risk Analysis', buyerAgentName: 'Alice', buyerAgentId: '5678', testFlag: true, status: 1, serviceTokenAmount: '10', paymentTokenSymbol: 'USDT',
    periodIndex: 2, subStartTime: 1788192600, subEndTime: 1790784600, periodStartTime: 1790784000, periodEndTime: 1793376000, autoRenew: 1, createTime: 1788192600 };
  const t = buildDetailResult('9001', d, TaskKind.Subscription).payload.task;
  assert.deepEqual([t.userName, t.userAgentId, t.testFlag, t.statusLabel, t.billingCycleLabel], ['Alice', '5678', true, 'Active', 'Monthly']);
  assert.equal(t.currentPeriod, `${dateOnly(d, ['periodStartTime'])}–${dateOnly(d, ['periodEndTime'])}`);
  assert.equal(typeof t.createdAt, 'string');
  const dispute = decodeDisputeStatusResponse({ jobId: 'job-1', jobType: 0, taskStatus: 4, currentRound: 1, disputeRoundStatus: 1 });
  const arb = buildProviderArbitrationDetailResult('9001', { jobId: 'job-1', title: 'Risk', buyerAgentId: '5678', testFlag: true, status: 4, tokenAmount: '1', tokenSymbol: 'USDT' }, TaskKind.OneTime, dispute);
  assert.deepEqual([arb.phase, arb.payload.task.jobId, arb.payload.task.testFlag, arb.payload.arbitration.jobId], ['provider_task_detail', 'job-1', true, 'job-1']);
});

// ── flow.rs ──
test('asp flow helpers', async () => {
  assert.equal(rejectExpireTime({ expireTime: 100 }), 100);
  assert.equal(rejectExpireTime({ expireTime: 0 }), undefined);
  assert.equal(rejectExpireTime({ expireTime: -1 }), undefined);
  assert.equal(rejectExpireTime(undefined), undefined);
  assert.ok(taskParamsRequestCommand('j', 'b', 'single').includes('\\"taskType\\":\\"single\\"'));
  assert.ok(displayNotify('h', 'c', 'hint').endsWith('content:\nc\n\nhint\n'));
  const run = (event, msg = {}, pre = null, title = 'My Sub') => aspNext('0xsub01', event, '864', title, null, pre, msg);
  assert.ok((await run('dispute_approved')).includes('compatibility receipt'));
  const submitted = await run('job_submitted');
  assert.ok(submitted.includes("Waiting for the User Agent's review") && submitted.includes('must NOT trigger a second A2A send'));
  const task = PreFetchedTaskContext.fromApiResponse({ title: 'One-time work', jobType: 0, paymentTokenAmount: '1', tokenSymbol: 'USDT', status: 4, providerAgentId: '864' });
  const disputed = await run('job_disputed', { buyerAgentId: '8315' }, task);
  assert.ok(disputed.includes('taskType` is `one_time`') && disputed.includes('arbitration_reason_context_missing'));
  const free = JSON.parse(await run('job_rejected', { reason: 'no' }, PreFetchedTaskContext.fromApiResponse({ title: 'Daily', jobType: 0, paymentTokenAmount: '0', status: 9, providerAgentId: '864' })));
  assert.equal(free.payload.statusLabel, 'Failed');
  const blocked = JSON.parse(await run('agree_refund'));
  assert.deepEqual([blocked.reason, blocked.payload.details.receivedEvent], ['decision_metadata_missing', 'agree_refund']);
  assert.equal(await run('init'), '[Unknown state] init\n');
  const relay = JSON.parse(await run('user_decision_job_rejected', { decisionId: '0xsub01:job_rejected:e1', selectedActionId: 'dispute_raise', params: { reason: 'r' } }));
  assert.deepEqual([relay.reason, relay.nextAction[0].id, relay.nextAction[0].params.jobId], ['user_choice_resolved', 'raise_arbitration', '0xsub01']);
  assert.equal(JSON.parse(await run('user_decision_sub_user_reject', { decisionId: 'x' })).reason, 'decision_metadata_missing');
});

// ── verifier additions ──
test('format_fractional_unit rounds exact binary ties half-to-even like core::fmt', async () => {
  const { formatFixed } = await import('../../skill/onchainos-lite/lib/core/rs/num.mjs');
  assert.equal(formatFixed(0.125, 2), '0.12');
  assert.equal(formatFixed(0.375, 2), '0.38');
  assert.equal(formatFixed(0.625, 2), '0.62');
  assert.equal(formatFixed(1.125, 2), '1.12');
  assert.equal(formatFixed(0.0025, 4), '0.0025');
  assert.equal(formatFixed(2.5, 0), '2');
  assert.equal(formatFixed(-0.125, 2), '-0.12');
  assert.equal(formatFractionalUnit(450, 3600), '0.12');     // JS toFixed would give 0.13
  assert.equal(formatFractionalUnit(2250, 3600), '0.62');
  assert.equal(formatFractionalUnit(4050, 3600), '1.12');
  assert.equal(formatFractionalUnit(3150, 3600), '0.88');
  assert.equal(formatFractionalUnit(10800, 86400), '0.12');
  assert.equal(formatFractionalUnit(86399, 86400), '1');
});
test('subscription_status_code ignores Object.prototype names', () => {
  for (const s of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) assert.equal(subscriptionStatusCode(s), undefined, s);
  assert.equal(subscriptionListPath(1, 20, 'constructor'), undefined);
  assert.equal(subscriptionStatusCode(' CLOSE '), 7);
  assert.equal(subscriptionStatusCode('+4'), 4);
});
test('evidence paths follow PathBuf::join (no normalisation)', async () => {
  const { evidenceDir } = await import('../../skill/onchainos-lite/lib/agent/task/evaluator/helpers.mjs');
  const { pathJoin } = await import('../../skill/onchainos-lite/lib/core/rs/fs.mjs');
  if (process.platform === 'win32') {
    assert.equal(pathJoin('C:/h', 'task'), 'C:/h\\task');          // Node join would give C:\h\task
    assert.equal(pathJoin('C:/h/', 'task'), 'C:/h/task');
    assert.equal(pathJoin('C:', 'task'), 'C:task');
    assert.equal(pathJoin('C:\\h', 'a/b'), 'C:\\h\\a/b');
    assert.equal(pathJoin('C:\\h', '..'), 'C:\\h\\..');
    assert.equal(pathJoin('C:\\h', 'D:\\abs'), 'D:\\abs');
    assert.equal(pathJoin('C:\\h', '\\root'), 'C:\\root');
    assert.equal(pathJoin('\\\\srv\\share\\x', '/root'), '\\\\srv\\share/root');
  } else {
    assert.equal(pathJoin('/tmp//h', 'task'), '/tmp//h/task');
    assert.equal(pathJoin('/tmp/h/', 'a/../b'), '/tmp/h/a/../b');
    assert.equal(pathJoin('/tmp/h', '/abs'), '/abs');
  }
  assert.equal(pathJoin('', 'x'), 'x');
  assert.ok(evidenceDir('J', 'A').endsWith(process.platform === 'win32' ? 'task\\J\\dispute\\A' : 'task/J/dispute/A'));
});
test('attachment save uses Path::file_name semantics', async () => {
  const { fileName } = await import('../../skill/onchainos-lite/lib/core/rs/fs.mjs');
  assert.equal(fileName('dl/att.bin'), 'att.bin');
  assert.equal(fileName('dl/att.bin/'), 'att.bin');
  assert.equal(fileName('dl/att.bin/.'), 'att.bin');   // Node basename gives "."
  assert.equal(fileName('dl/..'), undefined);
  assert.equal(fileName('.'), undefined);
  assert.equal(fileName(''), undefined);
  assert.equal(fileName('/'), undefined);
  if (process.platform === 'win32') {
    assert.equal(fileName('C:'), undefined);
    assert.equal(fileName('C:\\'), undefined);
    assert.equal(fileName('C:foo'), 'foo');
    assert.equal(fileName('\\\\srv\\share'), undefined);
    assert.equal(fileName('C:\\x\\y.bin\\.'), 'y.bin');
  }
});
test('deliver temp paths follow std::env::temp_dir().join()', async () => {
  const { tmpPathFor } = await import('../../skill/onchainos-lite/lib/agent/task/asp/deliver.mjs');
  const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
  try {
    if (process.platform === 'win32') {
      process.env.TMP = 'C:\\tmp-a'; process.env.TEMP = 'C:\\tmp-b';
      assert.equal(tmpPathFor('deliverable_x.md'), 'C:\\tmp-a\\deliverable_x.md');   // TMP before TEMP
    } else {
      process.env.TMPDIR = '/var/tmp-a/';
      assert.equal(tmpPathFor('deliverable_x.md'), '/var/tmp-a/deliverable_x.md');
      process.env.TMPDIR = '/var/tmp-b';
      assert.equal(tmpPathFor('deliverable_x.md'), '/var/tmp-b/deliverable_x.md');
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
