// Unit tests for the user-create unit (lib/agent/task/user/{content,create,create-subscribe,
// negotiate,attachments,service-param-update,device-routing,offline-receive,visibility,my-tasks,
// service-detail,task-create-prepare,index,flow-negotate/*}). Oracles: the
// upstream Rust unit tests of task/user/{content,create,device_routing,service_param_update,
// task_create_prepare,visibility,my_tasks,negotiate,attachments}.rs.
// Never touches the network or spawns okx-a2a.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-user-create-'));
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
process.env.OKX_AGENT_TASK_HOME = join(HOME, 'okx-agent-task');
delete process.env.CLAUDECODE;
delete process.env.CODEX_THREAD_ID;
after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const U = '../../skill/onchainos-lite/lib/agent/task/user/';
const content = await import(`${U}content.mjs`);
const create = await import(`${U}create.mjs`);
const createSub = await import(`${U}create-subscribe.mjs`);
const negotiate = await import(`${U}negotiate.mjs`);
const att = await import(`${U}attachments.mjs`);
const spu = await import(`${U}service-param-update.mjs`);
const dr = await import(`${U}device-routing.mjs`);
const offline = await import(`${U}offline-receive.mjs`);
const vis = await import(`${U}visibility.mjs`);
const myTasks = await import(`${U}my-tasks.mjs`);
const sd = await import(`${U}service-detail.mjs`);
const tcp = await import(`${U}task-create-prepare.mjs`);
const idx = await import(`${U}index.mjs`);
const fn = await import(`${U}flow-negotiate/index.mjs`);
const { typed } = await import('../../skill/onchainos-lite/lib/core/cli.mjs');
const { stringify, parse, F64 } = await import('../../skill/onchainos-lite/lib/core/json.mjs');
const { UsageError, CodedError } = await import('../../skill/onchainos-lite/lib/core/errors.mjs');

const JOB = '0x' + 'ab'.repeat(32);
const throwsMsg = (f, msg) => assert.throws(f, (e) => { assert.equal(e.message, msg); return true; });

// ─── content.rs ───
test('content: job notification copy matches the Rust oracles', () => {
  assert.equal(content.subscriptionJobAspAcceptExpireUserNotify('BTC Signals', 'job-1', '12.34', 'USDT', 'Signal ASP', '5263', true),
    '[Job Expired] The ASP did not accept BTC Signals within 3 hours, so the job expired. Neither the subscription nor the free trial began.\n\nJob ID: job-1\nASP: Signal ASP (Agent ID: 5263)\nJob status: Expired\n\nYour free-trial eligibility remains unaffected.');
  assert.equal(content.subscriptionJobAspRejectClosedUserNotify('BTC Signals', 'job-1', '12.34', 'USDT', 'Signal ASP', '5263', 'capacity unavailable', true),
    '[ASP Declined] The ASP declined BTC Signals.\n\nJob ID: job-1\nASP: Signal ASP (Agent ID: 5263)\nReason: capacity unavailable\n\nThe job is closed. Neither the subscription nor the free trial began, and your free-trial eligibility remains unaffected.');
  assert.equal(content.subscriptionJobAspRejectExpireUserNotify('BTC Signals', 'job-1', '12.34', 'USDT', 1700000000),
    '[Automatic Refund Processing] The ASP did not respond to the refund request for BTC Signals by the deadline. 12.34 USDT will be returned to your wallet, subject to on-chain confirmation.\n\nJob ID: job-1\nResponse deadline: 2023-11-14 22:13 UTC\nJob status: Failed');
  assert.equal(content.regularJobAspAcceptExpireUserNotify('One-off analysis', 'job-2', '0', 'USDT', 'Analyst', '42', false),
    '[Job Expired] The ASP did not accept One-off analysis within 3 hours, so the job expired.\n\nJob ID: job-2\nASP: Analyst (Agent ID: 42)\nJob status: Expired');
  assert.equal(content.regularJobAspAcceptExpireUserNotify('One-off analysis', 'job-2', '5', 'USDT', 'Analyst', '42', true),
    '[Job Expired] The ASP did not accept One-off analysis within 3 hours, so the job expired. The escrowed amount of 5 USDT will be returned to your wallet.\n\nJob ID: job-2\nASP: Analyst (Agent ID: 42)\nJob status: Expired');
  assert.equal(content.regularJobAspRejectClosedUserNotify('One-off analysis', 'job-2', '0', 'USDT', 'Analyst', '42', 'policy', false),
    '[ASP Declined] The ASP declined One-off analysis.\n\nJob ID: job-2\nASP: Analyst (Agent ID: 42)\nReason: policy\nJob status: Closed');
  assert.equal(content.regularJobAspRejectExpireUserNotify('One-off analysis', 'job-2', '0', 'USDT', 1700000000, false),
    '[Refund Request Processed] The ASP did not respond to the refund request for One-off analysis by the deadline. No charges were incurred, so no refund is required.\n\nJob ID: job-2\nASP response deadline: 2023-11-14 22:13 UTC\nJob status: Failed');
  assert.equal(content.regularJobAspRejectExpireUserNotify('S', 'j', '1', 'USDT', undefined, true), content.subscriptionJobAspRejectExpireUserNotify('S', 'j', '1', 'USDT', undefined));
  assert.match(content.subscriptionJobAspRejectExpireUserNotify('S', 'j', '1', 'USDT', null), /Response deadline: Unavailable/);
});

test('content: fmt_epoch tolerates milliseconds and rejects non-positive', () => {
  assert.equal(content.fmtEpoch(1700000000), '2023-11-14 22:13 UTC');
  assert.equal(content.fmtEpoch(1700000000000), '2023-11-14 22:13 UTC');
  assert.match(content.fmtEpoch(1790000000000), /^2026-/);
  assert.equal(content.fmtEpoch(0), undefined);
  assert.equal(content.fmtEpoch(-5), undefined);
  assert.equal(content.fmtEpoch(undefined), undefined);
});

test('content: job accepted escrow notice renders Free only for exact zero decimals', () => {
  assert.match(content.jobAcceptedEscrowUserNotify('job-1', 'T', '0'), /Amount: Free/);
  assert.match(content.jobAcceptedEscrowUserNotify('job-1', 'T', '0.000000'), /Amount: Free/);
  for (const a of ['1.5', '', 'abc', '-0']) assert.match(content.jobAcceptedEscrowUserNotify('job-1', 'T', a), /Amount: <tokenAmount> <tokenSymbol>/);
  assert.ok(content.jobAcceptedEscrowUserNotify('job-1', 'T', '1').endsWith('\n         Waiting for the ASP to execute and submit the deliverable.'));
  process.env.CLAUDECODE = '1';
  try { assert.ok(content.jobAcceptedEscrowUserNotify('job-1', 'T', '1').endsWith('Amount: <tokenAmount> <tokenSymbol>')); } finally { delete process.env.CLAUDECODE; }
});

test('content: subscription copies (snapshots from the Rust tests)', () => {
  assert.equal(content.subExpireWarnUserNotify('JOB-999'),
    "[Renewal Reminder] Job `JOB-999` — your subscription's current period is ending soon. It will auto-renew on expiry. Cancel in advance via subscription management if you don't want this.");
  assert.equal(content.subExpireWarnNoAutorenewNotify('JOB-999', '2026-07-01', '2026-07-31'),
    '[Subscription Ending Soon] Subscription job JOB-999 (period 2026-07-01\u20132026-07-31) will expire and close on 2026-07-31. To continue using it, please enable auto-renew in time.');
  const full = content.subRejectRefundNotifyUser('My Sub', 1700000000, 1700500000, 1700600000, '0.0005', 'USDT');
  assert.ok(full.startsWith('[Auto-Refund]'));
  assert.ok(full.includes("'s period ("));
  assert.ok(full.includes('automatically issued a full refund of 0.0005 USDT to your wallet.'));
  const bare = content.subRejectRefundNotifyUser('My Sub', null, null, null, null, null);
  assert.ok(bare.includes('for "My Sub" went unanswered'));
  assert.ok(bare.includes('automatically issued a full refund to your wallet.'));
  assert.ok(!bare.includes('()'));
  const created = content.subCreatedUserNotify('job-1', 'My Sub', '1.500000', 'USDT', 1700000000, 1700500000, true);
  assert.ok(created.startsWith('[Subscribed]') && created.includes('First charge of 1.500000 USDT completed') && created.includes('next charge date:'));
  assert.ok(content.subCreatedUserNotify('job-1', 'My Sub', '1.5', 'USDT', 1700000000, 1700500000, false).includes(' Auto-renew is off.'));
  assert.equal(content.subRenewUserNotify(null, null, 'S', 'j', '1', 'USDT', null, null, null), '[Renewed] "S" — this cycle\'s renewal of 1 USDT is complete..');
  assert.equal(content.subCancelUserNotify('fail', 'r', null, 'S', 'j', null), '[Subscription Cancellation Failed] Your subscription could not be cancelled.\n         Reason: r');
  assert.equal(content.subCancelUserNotify(null, null, 1, 'S', 'j', null), '[Cancelled] The free trial for "S" has been cancelled and access ends immediately. No conversion charge will occur.');
  assert.equal(content.subCloseNotifyUserNotify('S', 'j', null, null, '  '), '[Service Closed] "S" has ended. Job j status: Closed.');
  assert.ok(content.subOpenUserNotify('job-1', 'My Sub', '1.5', 'USDT').includes('1.5 USDT has been funded'));
  assert.ok(content.subOpenTrialUserNotify('job-1', 'My Sub', '1.5', 'USDT').includes('1.5 USDT is the paid-period price'));
});

test('content: scoped watch handoff keeps the re-entry contract', () => {
  const out = content.scopedWatchHandoff('job-123');
  assert.ok(out.includes('Do NOT end the turn merely because one watch call returned'));
  assert.ok(out.includes('re-enter the same scoped command'));
  assert.ok(out.includes('job-id `job-123`'));
  assert.ok(!out.includes('End the turn after Step 2'));
});

// ─── create.rs ───
test('create: currency normalisation and decimal validation', () => {
  assert.equal(create.normalizeCurrency('usd₮0'), 'USDT');
  assert.equal(create.normalizeCurrency('USDT0'), 'USDT');
  assert.equal(create.normalizeCurrency('usdg'), 'USDG');
  throwsMsg(() => create.normalizeCurrency('BTC'), 'unsupported token: BTC; only USDT (USD₮0) and USDG are supported');
  create.validateDecimalAmount('0.000001', 'amount');
  create.validateDecimalAmount(' 12 ', 'amount');
  throwsMsg(() => create.validateDecimalAmount('0.0000001', 'amount'), '--amount must be a decimal string with at most 6 decimal places');
  throwsMsg(() => create.validateDecimalAmount('1e3', 'amount'), '--amount must be a decimal string with at most 6 decimal places');
  throwsMsg(() => create.validateDecimalAmount('1.', 'amount'), '--amount must be a decimal string with at most 6 decimal places');
  throwsMsg(() => create.validateDecimalAmount('-1', 'amount'), '--amount must be a non-negative decimal string');
  throwsMsg(() => create.validateDecimalAmount('   ', 'amount'), '--amount must be a non-negative decimal string');
});

test('create: title limits use Unicode scalar counts', () => {
  create.validateTitle('任'.repeat(30));
  throwsMsg(() => create.validateTitle('任'.repeat(31)), 'title may not exceed 30 characters (currently 31)');
  throwsMsg(() => create.validateTitle('  '), 'title must not be empty');
});

test('create: validate_draft_fields report shape', () => {
  const r = create.validateDraftFields('short', 'ok', 1.1234567, 1, 'btc');
  assert.equal(stringify(r), stringify({
    checks: [
      { error: 'description is too short (minimum 20 chars, currently 5)', field: 'description', ok: false },
      { field: 'title', ok: true },
      { error: 'unsupported token: btc; only USDT (USD₮0) and USDG are supported', field: 'currency', ok: false },
      { error: 'budget precision is limited to 6 decimal places, currently 7', field: 'budget', ok: false },
      { field: 'max_budget', ok: true },
    ],
    errors: ['description is too short (minimum 20 chars, currently 5)', 'unsupported token: btc; only USDT (USD₮0) and USDG are supported',
      'budget precision is limited to 6 decimal places, currently 7', 'max_budget (1) must be >= budget (1.1234567)'],
    ok: false,
  }));
  assert.equal(create.validateDraftFields(undefined, undefined, undefined, undefined, 'USDT').checks[0].normalized, 'USDT');
  throwsMsg(() => create.validateBudget(10000001), 'per-task budget may not exceed 10000000 USDT/USDG');
  throwsMsg(() => create.validateBudget(-1), 'budget must be a non-negative amount');
});

const params = (over = {}) => ({
  title: 'Market report', description: 'Summarize the confirmed market inputs', descriptionSummary: 'Market summary', providerAgentId: '6508',
  paymentTokenSymbol: 'USDT', paymentTokenAmount: '10.25', attachments: undefined, serviceId: 'svc-1', serviceParams: '{}', serviceTokenAddress: '0xtoken',
  serviceTokenAmount: '10.25', categoryCode: 'FINANCE', minCreditScore: 0.5, visibility: 'private', chainId: '196', serviceGuide: undefined,
  serviceGuideHash: undefined, guideConsentJson: undefined, ...over,
});

test('create: fixed-price params validate without budget or payment mode', () => {
  const v = create.validateCreateTaskParams(params({ title: 'A & B | C; `x` $(y)' }));
  assert.equal(v.tokenSymbol, 'USDT');
  assert.equal(v.visibility, 1);
  assert.equal(v.title, 'A B C x y');
  assert.equal(v.guideConsent, undefined);
  assert.equal(create.validateCreateTaskParams(params({ visibility: 'public' })).visibility, 0);
  throwsMsg(() => create.validateCreateTaskParams(params({ minCreditScore: NaN })), '--min-credit-score must be between 0 and 1');
  throwsMsg(() => create.validateCreateTaskParams(params({ chainId: '1' })), '--chain-id currently supports X Layer (196) only');
  throwsMsg(() => create.validateCreateTaskParams(params({ serviceParams: 'x' })), '--service-params must be valid JSON: expected value at line 1 column 1');
  throwsMsg(() => create.validateCreateTaskParams(params({ guideConsentJson: '{}' })), 'Guide Consent requires --service-guide');
  const g = create.validateCreateTaskParams(params({ serviceGuide: 'guide text', guideConsentJson: '{"b":1,"a":2}' }));
  assert.equal(g.guideConsent.draft.sourceHash.length, 64);
  assert.deepEqual(Object.keys(g.guideConsent.consentValues).sort(), ['a', 'b']);
  throwsMsg(() => create.validateCreateTaskParams(params({ serviceGuide: 'guide text', guideConsentJson: '{"accessToken":1}' })), 'credentials must not be stored in Guide Consent: accessToken');
  throwsMsg(() => create.validateCreateTaskParams(params({ serviceGuide: 'guide A', serviceGuideHash: '0'.repeat(64), guideConsentJson: '{}' })), '--service-guide-hash does not match --service-guide');
});

test('create: task-creation funding result uses the common funding contract', () => {
  const r = create.buildTaskCreationFundingResult({ currency: 'USDT', required: '0.01', available: '0' },
    { address: '0x1234567890abcdef1234567890abcdef12345678', chainIndex: '196' }, '0x779ded0c9e1022225f8e0630b35a9b54be713736');
  assert.equal(r.phase, 'funding_required');
  assert.equal(r.decision, 'blocked');
  assert.equal(r.reason, 'insufficient_balance');
  assert.deepEqual(r.nextAction, []);
  assert.equal(r.payload.operation, 'task_creation');
  assert.equal(r.payload.fundingNeed.required, '0.01');
  assert.equal(typeof r.payload.qr, 'object');
});

// ─── create_subscribe.rs ───
test('create-subscribe: validation order and duplicate block', () => {
  const p = (over = {}) => ({ serviceId: 's', serviceTokenAmount: '1', serviceTokenAddress: '0xA', autoRenew: 1, providerAgentId: '1', title: 't', description: 'd', ...over });
  throwsMsg(() => createSub.validateCreateSubscribeParams(p({ serviceId: '' })), '--service-id is required');
  throwsMsg(() => createSub.validateCreateSubscribeParams(p({ autoRenew: 2 })), '--auto-renew must be 0 (off) or 1 (on), got 2');
  throwsMsg(() => createSub.validateCreateSubscribeParams(p({ title: 'x'.repeat(31) })), '--title exceeds 30 characters');
  throwsMsg(() => createSub.validateCreateSubscribeParams(p({ description: 'x'.repeat(4097) })), '--description exceeds 4096 characters');
  throwsMsg(() => createSub.validateCreateSubscribeParams(p({ guideConsentJson: '{}' })), 'guide-driven signal execution requires --service-guide');
  assert.equal(createSub.validateCreateSubscribeParams(p()), undefined);
  const block = createSub.buildDuplicateSubscriptionBlock('svc-1', { jobId: 'job-9', serviceId: 'svc-1', providerAgentId: '2', statusLabel: 'Active',
    statusDescription: 'The subscription is active.', restoreListeningAvailable: true, title: 'hidden', status: 1, statusName: 'ACTIVE' });
  assert.equal(stringify(block), '{"blockedReason":"duplicate-subscription","existingSubscription":{"jobId":"job-9","providerAgentId":"2","restoreListeningAvailable":true,"serviceId":"svc-1","statusDescription":"The subscription is active.","statusLabel":"Active"},"nextAfterUserChoice":["restore-listening"],"userFacingPrompt":"Service svc-1 already has a subscription task, jobId: job-9. It cannot be created again. Would you like to restore listening?"}');
});

// ─── mod.rs ───
test('mod: parse_bool_or_int and post-login summary', () => {
  assert.equal(idx.parseBoolOrInt('true', 'auto-renew'), 1);
  assert.equal(idx.parseBoolOrInt('0', 'auto-renew'), 0);
  throwsMsg(() => idx.parseBoolOrInt('TRUE', 'auto-renew'), '--auto-renew must be 0, 1, true, or false; got "TRUE"');
  const subs = { list: [{ status: 1 }, { status: 7, statusName: 'active' }, { status: 0, statusName: 'CREATED' }, { statusName: 'ACTIVE' }] };
  assert.equal(idx.activeSubscriptionCount(subs), 3);
  assert.deepEqual(idx.composePostLoginSubscriptions(subs), { activeSubscriptionCount: 3 });
  assert.equal(idx.composePostLoginSubscriptions({ list: [{ status: 7 }] }), null);
  assert.equal(idx.composePostLoginSubscriptions({}), null);
  assert.equal(idx.deviceNeedsDefaultRouting(true, false), false);
  assert.equal(idx.deviceNeedsDefaultRouting(false, false), true);
  assert.equal(idx.deviceNeedsDefaultRouting(true, true), true);
  assert.equal(idx.deviceSnapshotContains({ list: [{ deviceId: 'a' }] }, 'a'), true);
  assert.equal(idx.deviceSnapshotContains({ list: [] }, 'a'), false);
  assert.equal(idx.deviceSnapshotContains({}, 'a'), undefined);
});

// ─── negotiate.rs ───
test('negotiate: mark_failed creates, dedups and clears a matching designated provider', () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  try {
    negotiate.saveDesignatedProvider('job-n', '42');
    assert.equal(negotiate.getDesignatedProvider('job-n'), '42');
    assert.equal(negotiate.hasDesignatedProvider('job-n'), true);
    negotiate.markFailed('job-n', '42');
    negotiate.markFailed('job-n', '42');
    negotiate.markFailed('job-n', '43');
  } finally { process.stdout.write = orig; }
  assert.deepEqual(lines, ['✓ Marked provider 42 as failed negotiation (job=job-n)\n', '✓ Marked provider 42 as failed negotiation (job=job-n)\n', '✓ Marked provider 43 as failed negotiation (job=job-n)\n']);
  assert.equal(negotiate.hasDesignatedProvider('job-n'), false);
  assert.deepEqual(negotiate.loadFailed('job-n'), ['42', '43']);
  const raw = readFileSync(join(HOME, 'task', 'job-n', 'negotiate-state.json'), 'utf8');
  assert.match(raw, /^\{\n  "jobId": "job-n",\n  "providers": \[\],\n  "currentIndex": 0,\n  "createdAt": "[^"]+\+00:00",\n  "page": 0,\n  "failedProviders": \[\n    "42",\n    "43"\n  \]\n\}$/);
});

test('negotiate: save / current / next keep f64 fields and failed providers', () => {
  const provider = { providerAddress: '0x1', providerAgentId: '7', matchScore: 1, creditScore: 5, capabilitySummary: 'c', completedTaskCount: 2,
    services: [{ serviceId: 's', serviceName: 'n', serviceType: 'A2A', feeAmount: 0 }, { serviceId: 't', serviceName: 'm', serviceType: 'A2A' }] };
  negotiate.save('job-n', [provider, { ...provider, providerAgentId: '8' }], 3);
  const text = readFileSync(join(HOME, 'task', 'job-n', 'negotiate-state.json'), 'utf8');
  assert.ok(text.includes('"matchScore": 1.0') && text.includes('"feeAmount": 0.0') && text.includes('"feeAmount": null') && text.includes('"page": 3'));
  assert.deepEqual(negotiate.loadFailed('job-n'), ['42', '43']);
  assert.equal(negotiate.current('job-n').providerAgentId, '7');
  assert.equal(negotiate.next('job-n').providerAgentId, '8');
  assert.equal(negotiate.next('job-n'), undefined);
  throwsMsg(() => negotiate.load('nope'), 'Negotiation state not found; run `onchainos agent asp-match --job-id nope` first');
  mkdirSync(join(HOME, 'task', 'job-n', 'attachments'), { recursive: true });
  negotiate.cleanup('job-n');
  assert.equal(existsSync(join(HOME, 'task', 'job-n', 'negotiate-state.json')), false);
  assert.equal(existsSync(join(HOME, 'task', 'job-n', 'attachments')), true);
  negotiate.cleanup('job-gone');
});

// ─── attachments.rs ───
test('attachments: Path::file_name / file_stem / extension semantics', () => {
  assert.equal(att.pathFileName('dir/a.txt'), 'a.txt');
  assert.equal(att.pathFileName('dir/sub/'), 'sub');
  assert.equal(att.pathFileName('dir/..'), undefined);
  assert.equal(att.pathFileName('/'), undefined);
  assert.equal(att.fileStem('a.tar.gz'), 'a.tar');
  assert.equal(att.fileExtension('a.tar.gz'), 'gz');
  assert.equal(att.fileStem('.bashrc'), '.bashrc');
  assert.equal(att.fileExtension('.bashrc'), undefined);
  assert.equal(att.fileStem('a.'), 'a');
  assert.equal(att.fileExtension('a.'), '');
  assert.equal(att.fileStem('noext'), 'noext');
});

test('attachments: unsafe job ids fail closed; copy + dedup + sorted listing', () => {
  for (const bad of ['../../x', 'a/b', '..', '', 'x'.repeat(257)]) {
    assert.throws(() => att.attachmentsDir(bad), (e) => e instanceof CodedError && e.code === 'UNSAFE_JOB_PATH_COMPONENT');
  }
  assert.deepEqual(att.listAttachmentPaths('../x'), []);
  const src = join(HOME, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'b.tar.gz'), 'b');
  writeFileSync(join(src, 'a.txt'), 'hello');
  const m = att.copyAttachmentsToJobWithManifest(JOB, [join(src, 'b.tar.gz'), join(src, 'a.txt'), join(src, 'b.tar.gz')]);
  assert.deepEqual(m.map((x) => x.fileName), ['b.tar.gz', 'a.txt', 'b.tar.gz']);
  assert.ok(m[2].storedPath.endsWith('b.tar_2.gz'));
  assert.equal(m[1].size, 5);
  assert.equal(stringify(m[1]), stringify({ fileName: 'a.txt', size: 5, sourcePath: join(src, 'a.txt'), storedPath: join(HOME, 'task', JOB, 'attachments', 'a.txt') }));
  assert.deepEqual(att.listAttachmentPaths(JOB).map((p) => att.pathFileName(p)), ['a.txt', 'b.tar.gz', 'b.tar_2.gz']);
  assert.deepEqual(att.copyAttachmentsToJobWithManifest(JOB, []), []);
  assert.throws(() => att.validateAttachmentSources([join(src, 'missing.txt')]), /^Error: attachment file is not readable: /);
  throwsMsg(() => att.validateAttachmentSources([src]), `attachment path is not a regular file: ${src}`);
});

// ─── service_param_update.rs ───
test('service-param-update: complete JSON is required', () => {
  throwsMsg(() => spu.validateInputs('job-1', 'buyer-1', 'req-1', 1, ''), '--service-params must contain the complete updated parameters');
  throwsMsg(() => spu.validateInputs('job-1', 'buyer-1', 'req-1', 1, 'plain text'), '--service-params must be one complete JSON value: expected value at line 1 column 1');
  assert.equal(stringify(spu.validateInputs('job-1', 'buyer-1', 'req-1', 1, '{"symbol":"SOL"}')), '{"symbol":"SOL"}');
  throwsMsg(() => spu.validateInputs(' ', 'b', 'r', 1, '{}'), 'jobId is required');
  throwsMsg(() => spu.validateInputs('j', 'b', 'r', 4, '{}'), '--round must be between 1 and 3');
  assert.equal(spu.statePath('/root', 'job-1').replace(/\\/g, '/'), '/root/6a6f622d31.json');
});

test('service-param-update: successful rounds are sequential, deduplicated and capped', () => {
  const p = parse('{"symbol":"SOL"}');
  const state = { successfulUpdates: [] };
  assert.equal(spu.validateRound(state, 'req-1', 1, p), undefined);
  state.successfulUpdates.push({ requestId: 'req-1', round: 1, serviceParams: p });
  assert.ok(spu.validateRound(state, 'req-1', 1, parse('{ "symbol" : "SOL" }')));
  throwsMsg(() => spu.validateRound(state, 'req-1', 1, parse('{"symbol":"BTC"}')), 'requestId was already used with different round or serviceParams');
  throwsMsg(() => spu.validateRound(state, 'req-2', 3, p), '--round must be the next successful round (2)');
  for (const r of [2, 3]) state.successfulUpdates.push({ requestId: `req-${r}`, round: r, serviceParams: p });
  throwsMsg(() => spu.validateRound(state, 'req-4', 3, p), 'three successful task-parameter updates already completed; provider must accept or decline');
  assert.equal(spu.valueEq(parse('1'), parse('1.0')), false);
  assert.equal(spu.valueEq(parse('{"a":[1,{"b":2.5}]}'), parse('{"a":[1,{"b":2.5}]}')), true);
});

test('service-param-update: handle posts once, persists, then dedups without HTTP', async () => {
  const calls = [];
  const client = { endpoint: (j, a) => `/priapi/v1/aieco/task/${j}/${a}`, postMutationWithIdentity: async (path, body, agent) => { calls.push([path, body, agent]); return null; } };
  const r1 = await spu.handle(client, 'job-s', ' 1001 ', 'single', ' req-1 ', 1, '{"b":1,"a":2}');
  assert.equal(stringify(calls), stringify([['/priapi/v1/aieco/task/job-s/serviceParam', { serviceParams: '{"a":2,"b":1}' }, ' 1001 ']]));
  assert.equal(r1.reason, 'backend_update_confirmed');
  assert.equal(r1.payload.successfulRounds, 1);
  const r2 = await spu.handle(client, 'job-s', '1001', 'single', 'req-1', 1, '{"a":2,"b":1}');
  assert.equal(calls.length, 1);
  assert.equal(stringify(r2.payload), '{"backendUpdated":true,"duplicate":true,"jobId":"job-s","requestId":"req-1","round":1,"successfulRounds":1}');
  const file = readFileSync(spu.statePath(spu.stateRoot(), 'job-s'), 'utf8');
  assert.equal(file, '{\n  "successfulUpdates": [\n    {\n      "requestId": "req-1",\n      "round": 1,\n      "serviceParams": {\n        "a": 2,\n        "b": 1\n      }\n    }\n  ]\n}');
  assert.ok(existsSync(spu.statePath(spu.stateRoot(), 'job-s').replace(/\.json$/, '.lock')));
  const bad = { ...client, postMutationWithIdentity: async () => ({ ok: 1 }) };
  await assert.rejects(spu.handle(bad, 'job-s', '1', 'single', 'req-2', 2, '{}'), { message: 'serviceParam update returned unexpected data; do not send task_params_response: {"ok":1}' });
});

// ─── device_routing.rs ───
test('device-routing: paging helpers', () => {
  assert.deepEqual(dr.normalizePageParams(0, 0), [1, 20]);
  assert.deepEqual(dr.normalizePageParams(-5, -1), [1, 20]);
  assert.deepEqual(dr.normalizePageParams(3, 50), [3, 50]);
  assert.deepEqual(dr.normalizePageParams(1, 500), [1, 500]);
  assert.ok(dr.paginationDone(0, 20, 0, 0, 1, 1));
  assert.ok(dr.paginationDone(5, 20, 0, 5, 1, 1));
  assert.ok(dr.paginationDone(20, 20, 40, 40, 2, 1));
  assert.ok(dr.paginationDone(20, 20, 0, 200000, 1 + dr.MAX_PAGES, 1));
  assert.ok(!dr.paginationDone(20, 20, 100, 20, 1, 1));
  assert.ok(!dr.paginationDone(20, 20, 0, 20, 1, 1));
  assert.deepEqual(dr.decodeDevicePage([]), { list: [], total: 0 });
  assert.deepEqual(dr.decodeDevicePage(null), { list: [], total: 0 });
  assert.deepEqual(dr.decodeDevicePage([{ list: [{ deviceId: 'd2' }], total: 1 }]), { list: [{ deviceId: 'd2', deviceName: '', lastOnlineTime: 0 }], total: 1 });
  throwsMsg(() => dr.decodeDevicePage({ list: [{ lastOnlineTime: 'x' }] }), 'failed to parse device page: invalid type: string "x", expected i64');
  assert.equal(dr.fmtUnixMillis(0), '0');
  assert.match(dr.fmtUnixMillis(9223372036854775807n), /unparseable/);
  assert.match(dr.fmtUnixMillis(1784620000000), /^2026-07-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
});

test('device-routing: form A / form B normalisation', () => {
  assert.deepEqual(dr.normalizeItems('0x..', undefined, undefined), [{ jobId: '0x..', deviceList: [] }]);
  assert.deepEqual(dr.normalizeItems('0x..', ' d1, ,d2,', undefined), [{ jobId: '0x..', deviceList: ['d1', 'd2'] }]);
  throwsMsg(() => dr.normalizeItems(undefined, 'd1', undefined), 'either --job-id (form A) or --items (form B) is required');
  throwsMsg(() => dr.normalizeItems('', undefined, undefined), '--job-id must not be empty');
  throwsMsg(() => dr.normalizeItems(undefined, undefined, '[{"jobId":""}]'), '--items entries must each carry a non-empty jobId');
  throwsMsg(() => dr.normalizeItems(undefined, undefined, '[{"deviceList":[]}]'), '--items must be a JSON array of {jobId, deviceList} objects: missing field `jobId` at line 1 column 18');
  assert.deepEqual(dr.normalizeItems(undefined, undefined, '[]'), []);
  throwsMsg(() => dr.validateItemsLen(0), 'no subscriptions to update: provide --job-id or a non-empty --items array');
  dr.validateItemsLen(1);
  dr.validateItemsLen(100);
  throwsMsg(() => dr.validateItemsLen(101), 'too many items (101); at most 100 subscriptions per batch');
  assert.equal(stringify({ items: dr.buildItemsArray([{ jobId: '0x..', deviceList: ['device1', 'device2'] }]) }), '{"items":[{"deviceList":["device1","device2"],"jobId":"0x.."}]}');
});

test('device-routing: new-device plan preserves tri-state and existing receivers', () => {
  const snapshot = { list: [{ jobId: 'default-all', deviceList: null }, { jobId: 'explicit-none', deviceList: [] }, { jobId: 'selected', deviceList: ['d1', 'd2'] },
    { jobId: 'already-enabled', deviceList: ['d-new'] }, { jobId: 'missing-default-all' }] };
  assert.deepEqual(dr.planNewDeviceUpdates(snapshot, 'd-new'), [{ jobId: 'explicit-none', deviceList: ['d-new'] }, { jobId: 'selected', deviceList: ['d1', 'd2', 'd-new'] }]);
  assert.deepEqual(dr.planNewDeviceUpdates({ list: [{ jobId: 'j1', deviceList: ['d1', 'd-new'] }, { jobId: 'j2', deviceList: null }] }, 'd-new'), []);
  throwsMsg(() => dr.planNewDeviceUpdates({ list: [{ deviceList: [] }] }, 'd-new'), 'subscription requiring a device update is missing its jobId');
  throwsMsg(() => dr.planNewDeviceUpdates({ list: [{ jobId: 'j', deviceList: 'x' }] }, 'd'), 'subscription snapshot contains a malformed deviceList');
  throwsMsg(() => dr.planNewDeviceUpdates({}, 'd'), 'subscription snapshot is missing its list');
  throwsMsg(() => dr.planNewDeviceUpdates({ list: [] }, ''), 'cannot enable subscription delivery for an empty device id');
  assert.equal(dr.normalizeRoutingScope('https://web3.okx.com/?a=1#x'), 'https://web3.okx.com');
  assert.equal(dr.normalizeRoutingScope('http://127.0.0.1:18899/api/'), 'http://127.0.0.1:18899/api');
  throwsMsg(() => dr.normalizeRoutingScope('ftp://x'), 'device-routing state requires an HTTP(S) API origin');
});

test('device-routing: markers are environment scoped; fan-out resumes from the remaining set', async () => {
  const prod = 'https://web3.okx.com', alt = 'https://beta.okex.org';
  assert.equal(dr.newDeviceRoutingIsPending(prod, 'agent-1', 'device-1'), false);
  dr.markNewDeviceRoutingPending(prod, 'agent-1', 'device-1');
  assert.equal(dr.newDeviceRoutingIsPending(prod, 'agent-1', 'device-1'), true);
  assert.equal(dr.newDeviceRoutingIsPending(alt, 'agent-1', 'device-1'), false);
  assert.equal(dr.newDeviceRoutingIsPending(prod, 'agent-1', 'device-2'), false);
  const path = dr.pendingRoutingMarkerPath(prod, 'agent-1', 'device-1');
  assert.equal(readFileSync(path, 'utf8'), '{"version":2,"phase":"detected","remainingJobIds":[]}');
  const posts = [];
  const client = { postWithIdentity: async (p, body, agent) => { posts.push([p, body, agent]); return true; } };
  const subs = { list: [{ jobId: 'j1', deviceList: [] }, { jobId: 'j2', deviceList: null }, { jobId: 'j3', deviceList: ['d1'] }] };
  assert.equal(await dr.addNewDeviceToAllSubscriptions(client, prod, 'agent-1', subs, 'device-1'), 2);
  assert.equal(stringify(posts), stringify([['/priapi/v1/aieco/task/subscribe/device/batchUpdate', { items: [{ deviceList: ['device-1'], jobId: 'j1' }, { deviceList: ['d1', 'device-1'], jobId: 'j3' }] }, 'agent-1']]));
  assert.equal(readFileSync(path, 'utf8'), '{"version":2,"phase":"completed","remainingJobIds":[]}');
  assert.deepEqual(subs.list.map((r) => r.thisDeviceReceives), [true, true, true]);
  await assert.rejects(dr.addNewDeviceToAllSubscriptions(client, prod, 'agent-1', subs, 'device-1'), { message: 'new-device routing is already completed; refusing to rewrite subscriptions' });
  dr.clearNewDeviceRoutingState(prod, 'agent-1', 'device-1');
  assert.equal(existsSync(path), false);
  await assert.rejects(dr.addNewDeviceToAllSubscriptions(client, prod, 'agent-1', subs, 'device-1'), { message: 'new-device routing state is missing' });
  writeFileSync(path, '{"version":3,"phase":"detected"}');
  assert.throws(() => dr.newDeviceRoutingIsPending(prod, 'agent-1', 'device-1'), /^Error: unsupported device-routing state version 3 in /);
});

// ─── offline_receive.rs / visibility.rs ───
test('offline-receive and visibility: wire values and success predicates', () => {
  assert.equal(offline.parseOfflineFlag('0'), 0);
  assert.equal(offline.parseOfflineFlag('1'), 1);
  throwsMsg(() => offline.parseOfflineFlag('true'), '--flag must be 0 (keep offline backlog) or 1 (discard offline backlog); got "true"');
  assert.equal(offline.offlineReceivePath('0xS'), '/priapi/v1/aieco/task/subscribe/0xS/setOfflineReceiveFlag');
  assert.ok(offline.isOfflineUpdateSuccess(null) && offline.isOfflineUpdateSuccess(true) && !offline.isOfflineUpdateSuccess(false));
  assert.equal(stringify(offline.buildOfflineSuccess('j', 1, { supported: false, fixCommands: [] })),
    '{"jobId":"j","offlineReceiveFlag":1,"offlineReplayFixCommands":["npm install -g @okxweb3/a2a-node@latest"],"offlineReplaySupported":false}');
  assert.equal(stringify(offline.buildOfflineSuccess('j', 0, { supported: true, fixCommands: [] })), '{"jobId":"j","offlineReceiveFlag":0,"offlineReplaySupported":true}');
  assert.equal(vis.TaskVisibility.updateApiValue('public'), 1);
  assert.equal(vis.TaskVisibility.updateApiValue('private'), 0);
  assert.ok(vis.isSuccess(null) && !vis.isSuccess(false));
});

// ─── my_tasks.rs ───
test('my-tasks: paths, page validation and output composition', () => {
  assert.equal(myTasks.listPath('one-time', 2, 25, 1), '/priapi/v1/aieco/task/my?page=2&pageSize=25&statusType=1');
  assert.equal(myTasks.listPath('subscription', 2, 25, 2), '/priapi/v1/aieco/task/subscribe/my?page=2&pageSize=25&statusType=2');
  assert.equal(myTasks.listPath('one-time', 1, 20, 0), '/priapi/v1/aieco/task/my?page=1&pageSize=20&statusType=1');
  const sub = myTasks.pageFromValue({ total: 3, totalNoCondition: 12, page: 1, pageSize: 20, list: [{ jobId: 'sub-1' }] }, 'subscription');
  const one = myTasks.pageFromValue({ total: 2, totalNoCondition: 8, page: 1, pageSize: 20, list: [{ jobId: 'task-1', status: 6 }, { status: -1 }, { status: 17 }] }, 'one-time');
  assert.deepEqual(one.list.map((r) => r.statusName), ['completed', 'init', 'status_17']);
  assert.equal(one.list[0].statusLabel, 'Completed');
  const out = myTasks.composeOutput('all', 0, 1, 20, sub, one);
  assert.deepEqual(out.summary, { subscription: { all: 12, active: 3 }, oneTime: { all: 8, active: 2 } });
  assert.equal(out.subscriptions.statusType, 1);
  assert.equal(out.subscriptions.thisDeviceId, null);
  assert.equal(out.oneTimeTasks.hasNext, false);
  assert.equal(out.oneTimeTasks.thisDeviceId, undefined);
  assert.deepEqual(myTasks.composeOutput('one-time', 2, 1, 20, undefined, one).summary, { oneTime: { ended: 2 } });
  throwsMsg(() => myTasks.pageFromValue([], 'one-time'), 'one-time task page must be a JSON object');
  throwsMsg(() => myTasks.pageFromValue({ total: 1, totalNoCondition: 1, page: 4294967296, pageSize: 1, list: [] }, 'subscription'), 'subscription task page is missing numeric page');
  throwsMsg(() => myTasks.pageFromValue({ total: 1, totalNoCondition: 1, page: 1, pageSize: 1 }, 'one-time'), 'one-time task page is missing list array');
  throwsMsg(() => myTasks.composeOutput('all', 3, 1, 1, sub, one), 'status-type must be 0, 1, or 2; got 3');
  throwsMsg(() => myTasks.composeOutput('subscription', 0, 1, 1, sub, one), 'one-time results were supplied for an unrequested task type');
});

// ─── service_detail.rs / task_create_prepare.rs ───
test('service-detail + task-create-prepare helpers', () => {
  assert.equal(sd.scalarString(' 33803 '), '33803');
  assert.equal(sd.scalarString(33803), '33803');
  assert.equal(sd.scalarString(18446744073709551615n), '18446744073709551615');
  assert.equal(sd.scalarString('  '), undefined);
  assert.equal(sd.scalarString(new F64('1.5')), undefined);
  const trial = (support, free) => ({ supportSubscription: true, subscriptionInfo: { supportTrial: support, freeTrial: free } });
  assert.ok(tcp.trialAvailable(trial(true, 7)));
  assert.ok(tcp.trialAvailable(trial(true, '7')));
  assert.ok(!tcp.trialAvailable(trial(true, 0)));
  assert.ok(!tcp.trialAvailable(trial(true, null)));
  assert.ok(!tcp.trialAvailable(trial(false, 7)));
});

// ─── flow_negotiate ───
test('flow-negotiate: playbook generators', async () => {
  assert.equal(fn.jobPaymentModeChanged({ jobId: 'j', titleDisplay: 'T', paymentMode: 3 }),
    '[Legacy A2MCP Task payment] This path was removed. Do not sign, replay, or continue this Task flow; restart from an upstream invoke_a2mcp event.\n');
  assert.ok(fn.jobPaymentModeChanged({ jobId: 'j', titleDisplay: 'T', paymentMode: 1 }).includes('[Payment Mode Set] T (`j`) — payment mode updated successfully'));
  assert.ok((await fn.negotiateReply({ jobId: 'j', agentId: 'a' })).startsWith('[negotiate_reply] ❌ no prefetched task context for job j;'));
  assert.ok((await fn.negotiateReply({ jobId: 'j', agentId: 'a', prefetched: { providerAgentId: '' } })).startsWith('[negotiate_reply] ❌ prefetched task context has no providerAgentId'));
  const reply = await fn.negotiateReply({ jobId: 'j', agentId: 'a', prefetched: { providerAgentId: 'P', title: 'T', description: '' } });
  assert.ok(reply.startsWith('**Task fields (already fetched — do NOT call `common context`):**\n  • Title: T\n  • Description: (missing)\n🛑 **Price is locked**'));
  assert.ok(reply.includes('onchainos agent mark-failed j --provider P'));
  const err = fn.designated.branchError('j', 'a', 'short', 'dp');
  assert.ok(err.startsWith('[Designated ASP route: error] ASP dp encountered a routing error.\n[Role] User (User)\n\n'));
  assert.ok(err.includes('--source-event service_not_found') && err.includes('--source-event not_provider') && err.includes('--source-event provider_offline'));
  assert.ok(err.endsWith("  -> **end this turn** and wait for the user's reply.\n\n"));
  const created = await fn.jobCreated({ jobId: 'job-none', agentId: 'a', shortId: 's', titleDisplay: 'T' });
  assert.ok(created.startsWith('[Trigger] job_created (on-chain, no designated provider recorded locally)'));
});

// ─── clap value parsers of this unit's options (modelled in lib/spec.json, enforced by core/cli.mjs) ───
test('clap: ranged and boolish options come from the spec model', () => {
  assert.equal(typed('agent my-tasks', 'statusType', '2', 'u8'), 2);
  assert.throws(() => typed('agent my-tasks', 'statusType', '3', 'u8'), (e) => e.message.includes("invalid value '3' for '--status-type <STATUS_TYPE>': 3 is not in 0..=2"));
  assert.throws(() => typed('agent my-tasks', 'page', '0', 'u32'), (e) => e.message.includes('0 is not in 1..=4294967295'));
  // RangedI64ValueParser: parse as i64, report the declared bounds (never the u8 / u32 storage range)
  assert.throws(() => typed('agent service-param-update', 'round', '300', 'u8'), (e) => e.message.includes("invalid value '300' for '--round <ROUND>': 300 is not in 1..=3"));
  assert.throws(() => typed('agent my-tasks', 'pageSize', '4294967296', 'u32'), (e) => e.message.includes('4294967296 is not in 1..=100'));
  assert.equal(typed('agent create-subscribe', 'useTrial', 'Yes', 'bool'), true);
  assert.equal(typed('agent create-subscribe', 'useTrial', 'off', 'bool'), false);
  assert.throws(() => typed('agent create-subscribe', 'useTrial', 'maybe', 'bool'), (e) => e.message.includes("invalid value 'maybe' for '--use-trial <USE_TRIAL>': value was not a boolean"));
});

// ─── verifier regressions (oracles captured from the upstream 4.6.3 binary) ───
const { spawnSync } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const SEP = process.platform === 'win32' ? '\\' : '/';
const LITE_BIN = fileURLToPath(new URL('../../skill/onchainos-lite/bin/ocl.mjs', import.meta.url));
const runLite = (argv, env, cwd) => spawnSync(process.execPath, [LITE_BIN, ...argv], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

test('device-routing: --device-list CSV is split with Rust str::trim (U+0085 stripped, U+FEFF kept)', () => {
  // upstream: `--device-list "<U+0085>d1<U+0085>,<U+FEFF>d2,<U+3000>,<U+00A0>d3<U+2029>,<U+FEFF>"` → ["d1","<U+FEFF>d2","d3","<U+FEFF>"]
  assert.deepEqual(dr.parseCsvDevices('\u0085d1\u0085,\ufeffd2,\u3000,\u00a0d3\u2029,\ufeff'), ['d1', '\ufeffd2', 'd3', '\ufeff']);
  assert.deepEqual(dr.normalizeItems('0xS', ' d1 ,\u0085', undefined), [{ jobId: '0xS', deviceList: ['d1'] }]);
});

test('device-routing: i64 page / pageSize / total beyond 2^53 keep every digit', async () => {
  const paths = [];
  const client = { getWithAgentId: async (p) => { paths.push(p); return { list: [{ deviceId: 'x' }], total: 9007199254740993n }; } };
  const snap = await dr.fetchDeviceListSnapshot(client, '1001', 9007199254740993n, 9007199254740995n);
  assert.deepEqual(paths, ['/priapi/v5/wallet/agentic/agent/device-list?page=9007199254740993&pageSize=9007199254740995']);
  assert.equal(stringify({ page: snap.page, pageSize: snap.pageSize, total: snap.total }), '{"page":9007199254740993,"pageSize":9007199254740995,"total":9007199254740993}');
  const small = await dr.fetchDeviceListSnapshot({ getWithAgentId: async () => ({ list: [], total: 0 }) }, '1001', 0, 0);
  assert.equal(stringify([small.page, small.pageSize, small.total]), '[1,20,0]');
});

test('service-param-update: state paths use PathBuf::join (no normalisation)', () => {
  const saved = process.env.OKX_AGENT_TASK_HOME;
  try {
    process.env.OKX_AGENT_TASK_HOME = 'x/./y';
    assert.equal(spu.stateRoot(), `x/./y${SEP}task-params`);
    process.env.OKX_AGENT_TASK_HOME = `x${SEP}`;
    assert.equal(spu.stateRoot(), `x${SEP}task-params`);
    assert.equal(spu.statePath('r', 'jö'), `r${SEP}6ac3b6.json`);
  } finally { process.env.OKX_AGENT_TASK_HOME = saved; }
});

test('list-attachments / mark-failed: relative home and absolute jobId behave like PathBuf::join', () => {
  const base = mkdtempSync(join(tmpdir(), 'ocl-unit-uc-paths-'));
  try {
    mkdirSync(join(base, 'rel', 'task', '0xjob', 'attachments', 'sub'), { recursive: true });
    for (const n of ['b.txt', 'A.txt']) writeFileSync(join(base, 'rel', 'task', '0xjob', 'attachments', n), n);
    const env = { OCL_HOME: './rel', ONCHAINOS_HOME: './rel' };
    // upstream (Windows): ["./rel\\task\\0xjob\\attachments\\A.txt", …] (PathBuf::join keeps "./")
    const p = (n) => ['./rel', 'task', '0xjob', 'attachments', n].join(SEP);
    const r = runLite(['agent', 'list-attachments', '0xjob'], env, base);
    assert.equal(r.stdout, `${JSON.stringify([p('A.txt'), p('b.txt')], null, 2)}\n`);
    // upstream: an absolute jobId replaces the task root (PathBuf::join); the state lands there.
    const abs = join(base, 'abs-job');
    const m = runLite(['agent', 'mark-failed', abs, '--provider', '7'], env, base);
    assert.equal(m.status, 0);
    assert.equal(m.stdout, `✓ Marked provider 7 as failed negotiation (job=${abs})\n`);
    assert.match(readFileSync(join(abs, 'negotiate-state.json'), 'utf8'), /"failedProviders": \[\n {4}"7"\n {2}\]/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
