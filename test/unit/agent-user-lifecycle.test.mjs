// Unit tests for the user-side task lifecycle (lib/agent/task/user/{refund,asp-ops,subscription-ops,
// subscription-list,flow}.mjs, flow-lifecycle/**, v2/**; unit A4). Oracles: the upstream Rust unit tests
// of task/user/{refund,asp_ops,subscription_ops,subscription_list,flow}.rs, the derived examples in
// spec/extract/g14b-agent-user-lifecycle.md, and values produced by a rustc 1.95 build of the upstream
// helpers (pick_sample_indices, `{:.2}` float formatting). Never spawns okx-a2a (PATH is emptied).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-agent-user-lifecycle-'));
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
delete process.env.CLAUDECODE;
delete process.env.CODEX_THREAD_ID;
after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch {} });

const LIB = '../../skill/onchainos-lite/lib/';
const { stringify } = await import(`${LIB}core/json.mjs`);
const refund = await import(`${LIB}agent/task/user/refund.mjs`);
const asp = await import(`${LIB}agent/task/user/asp-ops.mjs`);
const subOps = await import(`${LIB}agent/task/user/subscription-ops.mjs`);
const subList = await import(`${LIB}agent/task/user/subscription-list.mjs`);
const flow = await import(`${LIB}agent/task/user/flow.mjs`);
const core = await import(`${LIB}agent/task/user/flow-lifecycle/core.mjs`);
const terminal = await import(`${LIB}agent/task/user/flow-lifecycle/terminal.mjs`);
const subscription = await import(`${LIB}agent/task/user/flow-lifecycle/subscription.mjs`);
const content = await (await import(`${LIB}agent/task/user/flow-lifecycle/_peers.mjs`)).content();
const subComplete = await import(`${LIB}agent/task/user/v2/sub-complete-notify.mjs`);
const jobCompleted = await import(`${LIB}agent/task/user/v2/job-completed.mjs`);
const reject = await import(`${LIB}agent/task/user/v2/reject.mjs`);
const complete = await import(`${LIB}agent/task/user/v2/complete.mjs`);
const notification = await import(`${LIB}agent/task/user/v2/notification.mjs`);
const caf = await import(`${LIB}agent/task/user/v2/create-and-fund.mjs`);
const cs = await import(`${LIB}agent/task/user/v2/create-subscription.mjs`);
const { PreFetchedTaskContext } = await import(`${LIB}agent/task/common/index.mjs`);

// ── refund.rs test fixture (upstream `task` / `snapshot` helpers) ──
const taskFx = (jobType, status, amount) => ({
  jobType, status, title: 'Audit task', buyerAgentId: 'buyer-1', providerAgentId: 'asp-1', providerAgentName: 'Example ASP', serviceId: 'svc-1',
  serviceName: 'Audit', tokenAmount: amount, tokenSymbol: 'USDT', tokenAddress: '0xtoken', paymentMode: 1, updatedAt: 42,
});
function snapshot(jobType, status, amount, over = {}, subOver = {}) {
  const task = { ...taskFx(jobType, status, amount), ...over };
  const sub = jobType === 1 ? { status, buyerAgentId: 'buyer-1', providerAgentId: 'asp-1', paymentTokenAmount: amount, tokenSymbol: 'USDT', trialType: 0,
    subStartTime: 1700000000, subEndTime: 1700100000, ...subOver } : undefined;
  return refund.RefundSnapshot.fromDetails('job-1', task, sub, 'buyer-1');
}

test('refund decimals: validate / zero / canonical / equal / tx hash', () => {
  for (const bad of ['0e0', '-0', '.', '1.', '.5', '', '1.2.3', ' 1', '1,0']) assert.equal(refund.validateDecimal(bad), false, bad);
  for (const good of ['0', '10', '0.0', '001.500']) assert.equal(refund.validateDecimal(good), true, good);
  assert.equal(refund.isZeroDecimal('0.000'), true);
  assert.equal(refund.isZeroDecimal('0.001'), false);
  assert.equal(refund.canonicalDecimal('001.500'), '1.5');
  assert.equal(refund.canonicalDecimal('000'), '0');
  assert.equal(refund.decimalEqual('5', '5.000'), true);
  assert.equal(refund.decimalEqual('5', '5.1'), false);
  assert.equal(refund.decimalEqual('x', 'x'), false);
  assert.equal(refund.validTxHash(`  0x${'ab'.repeat(32)} `), true);
  assert.equal(refund.validTxHash(`0X${'ab'.repeat(32)}`), false);
  assert.equal(refund.validTxHash(`0x${'ab'.repeat(31)}`), false);
});

test('refund scalar readers follow serde Value semantics', () => {
  assert.equal(refund.scalarString('  x '), 'x');
  assert.equal(refund.scalarString('   '), undefined);
  assert.equal(refund.scalarString(7), '7');
  assert.equal(refund.scalarI64(' +12 '), 12);
  assert.equal(refund.scalarI64('1.5'), undefined);
  assert.equal(refund.firstString([[{ a: ' ' }, ['a', 'b']], [{ b: 'z' }, ['b']]]), 'z');
});

test('refund context id matches the spec example (serde_json sorted compact JSON → sha256)', () => {
  assert.equal(snapshot(0, 0, '10').contextId(null), 'refundctx_0b8012f0ccd3ecb525c1f359a08aee202a7d1c3ed24d7e27c375c2219c740724');
  // userReason participates only in request-refund states
  assert.equal(snapshot(0, 0, '10').contextId('late'), snapshot(0, 0, '10').contextId(null));
  assert.notEqual(snapshot(0, 2, '10').contextId('late'), snapshot(0, 2, '10').contextId(null));
});

test('refund journal path matches the spec example', () => {
  assert.ok(refund.pendingStatePath('job-1', 'buyer-1').endsWith(join('refund-v2', '30b445852802fee0b0ec8228d8aaa2d0bd8cdbc533744593f909ce01be0e8c44.json')));
});

test('refund snapshot validation errors', () => {
  const from = (task, sub) => () => refund.RefundSnapshot.fromDetails('job-1', task, sub, 'buyer-1');
  assert.throws(from({ ...taskFx(0, 0, '1'), jobType: undefined }), /task detail is missing jobType/);
  assert.throws(from(taskFx(2, 0, '1')), /unsupported jobType=2/);
  assert.throws(from({ ...taskFx(0, 0, '1'), status: undefined }), /task detail is missing status/);
  assert.throws(from({ ...taskFx(0, 0, '1'), buyerAgentId: 'x' }), /not owned by the current User Agent/);
  assert.throws(from(taskFx(0, 0, '1.')), /invalid original token amount/);
  assert.throws(from({ ...taskFx(0, 0, '1'), tokenAddress: undefined }), /missing the original token address/);
  assert.throws(from(taskFx(1, 1, '1'), { status: 1, trialType: 3 }), /unsupported trialType=3/);
  assert.throws(from(taskFx(1, 1, '1'), { status: 1, trialType: 0, subStartTime: 5, subEndTime: 4 }), /invalid billing period/);
  // Expired(8) keeps equal placeholder timestamps
  assert.doesNotThrow(from(taskFx(1, 8, '1'), { status: 8, trialType: 0, subStartTime: 5, subEndTime: 5 }));
});

test('refund plan decision table', () => {
  const r = (s, reason) => s.plan(reason);
  assert.equal(r(snapshot(0, 0, '10')).reason, 'direct_refund_confirmation_required');
  assert.equal(r(snapshot(0, 0, '10')).operation, 'direct-refund');
  assert.equal(r(snapshot(0, 0, '10', { paymentMode: 0 })).reason, 'direct_refund_funding_not_verified');
  assert.equal(r(snapshot(0, 0, '0')).reason, 'zero_amount_close_confirmation_required');
  assert.equal(r(snapshot(0, 7, '0')).reason, 'zero_amount_task_closed');
  assert.equal(r(snapshot(0, 3, '0')).reason, 'zero_amount_close_contract_required');
  assert.equal(r(snapshot(0, 1, '10')).reason, 'accepted_task_refund_contract_required');
  assert.equal(r(snapshot(0, 2, '10')).reason, 'refund_reason_required');
  assert.equal(r(snapshot(0, 2, '10'), '  ').reason, 'refund_reason_required');
  assert.equal(r(snapshot(0, 2, '10'), 'x'.repeat(2001)).reason, 'refund_reason_too_long');
  assert.equal(r(snapshot(0, 2, '10'), 'x'.repeat(2000)).reason, 'refund_request_confirmation_required');
  assert.equal(r(snapshot(0, 2, '10', { paymentMode: 3 }), 'x').reason, 'refund_payment_not_verified');
  assert.equal(r(snapshot(0, 3, '10')).reason, 'provider_response_pending');
  assert.equal(r(snapshot(0, 4, '10')).actionId, 'view_arbitration');
  assert.equal(r(snapshot(0, 6, '10')).recommendStop, true);
  assert.equal(r(snapshot(0, 7, '10')).reason, 'refund_confirmed');
  assert.equal(r(snapshot(0, 7, '10', { paymentMode: 0 })).reason, 'refund_settlement_details_incomplete');
  assert.equal(r(snapshot(0, 8, '10')).reason, 'refund_confirmed');
  assert.equal(r(snapshot(0, 9, '10')).reason, 'refund_confirmed');
  assert.equal(r(snapshot(0, 5, '10')).reason, 'refund_not_available_for_status');
  assert.equal(r(snapshot(0, 0, '10', { providerAgentId: undefined })).reason, 'refund_task_details_incomplete');
  assert.equal(r(snapshot(1, 0, '10')).operation, 'close-created-subscription');
  assert.equal(r(snapshot(1, 1, '10'), 'bad').operation, 'request-refund');
  assert.equal(r(snapshot(1, 1, '10', {}, { subStartTime: undefined })).reason, 'subscription_period_contract_required');
  assert.equal(r(snapshot(1, 1, '10', {}, { trialType: 1, autoRenew: 1 })).operation, 'cancel-trial-conversion');
  assert.equal(r(snapshot(1, 1, '10', {}, { trialType: 1, autoRenew: 0 })).reason, 'trial_conversion_already_cancelled');
  assert.equal(r(snapshot(1, 1, '10', {}, { trialType: 1 })).reason, 'trial_conversion_state_unknown');
  assert.equal(r(snapshot(1, 7, '10', {}, { trialType: 1 })).reason, 'trial_subscription_closed_without_refund');
  assert.equal(r(snapshot(1, 7, '10')).reason, 'task_closed_no_new_refund_action');
  assert.equal(r(snapshot(1, 7, '0')).reason, 'zero_amount_subscription_not_refundable');
  assert.equal(r(snapshot(1, 8, '0')).reason, 'expired_without_refundable_payment');
  assert.equal(r(snapshot(1, 9, '10')).reason, 'refund_confirmed');
});

test('refund decision / action shapes (base_decision key order, plan actions)', () => {
  const d = refund.baseDecision('p', 'd', 'r', [], {});
  assert.equal(stringify(d), '{"decision":"d","nextAction":[],"payload":{},"phase":"p","reason":"r"}');
  assert.equal(stringify(refund.action('stop', true)), '{"id":"stop","recommend":true}');
  const s = snapshot(0, 2, '10');
  const acts = refund._internal.planActions(s, s.plan('late'), 'late');
  assert.equal(acts[0].id, 'submit_refund_request');
  assert.equal(acts[0].params.reason, 'late');
  assert.deepEqual(acts[1], { id: 'stop', recommend: false });
  const s4 = snapshot(0, 4, '10');
  assert.deepEqual(refund._internal.planActions(s4, s4.plan(null), null).map((a) => a.id), ['view_arbitration', 'stop']);
  const s3 = snapshot(0, 3, '10');
  assert.deepEqual(refund._internal.planActions(s3, s3.plan(null), null).map((a) => a.id), ['view_refund_status', 'watch_task']);
  assert.deepEqual(refund._internal.reconcileActions('j', 'request-refund'), [{ id: 'view_refund_status', recommend: false, params: { jobId: 'j' } }]);
});

test('refund payload: labels, scopes and settlement fields', () => {
  const s = snapshot(0, 9, '10');
  const p = s.payload(null, s.plan(null));
  assert.equal(p.display.statusLabel, 'Refund completed');
  assert.equal(p.settlement.state, 'confirmed');
  assert.equal(p.settlement.confirmationSource, 'backend_onchain_lifecycle');
  assert.equal(p.payment.refundScope, 'full_task_payment');
  assert.equal(p.display.serviceProviderLabel, 'Example ASP (Agent ID : asp-1)');
  assert.equal(p.job.statusName, 'failed');
  const sub = snapshot(1, 1, '10');
  const sp = sub.payload(null, sub.plan(null));
  assert.equal(sp.payment.refundScope, 'current_subscription_period');
  assert.equal(sp.display.currentPeriodLabel, '2023-11-14 22:13 (UTC+00:00)–2023-11-16 02:00 (UTC+00:00)');
  assert.deepEqual(sp.input.requiredParams, ['reason']);
  assert.equal(sp.subscription.kind, 'formal');
});

test('refund strict receipt / lifecycle type / preflight', () => {
  const { strictBroadcastReceipt, lifecycleBizType, validateLifecyclePreflight } = refund._internal;
  assert.throws(() => strictBroadcastReceipt([]), /did not contain a receipt object/);
  assert.throws(() => strictBroadcastReceipt({ pkgId: 'p', orderId: '', orderType: 't', bizUniqKey: 'k' }), /missing orderId/);
  assert.equal(strictBroadcastReceipt({ pkgId: 'p', orderId: 1, orderType: 't', bizUniqKey: 'k', txHash: ' ' }).txHash, null);
  assert.throws(() => strictBroadcastReceipt({ pkgId: 'p', orderId: 1, orderType: 't', bizUniqKey: 'k', txHash: '0x1' }), /invalid transaction hash/);
  assert.throws(() => strictBroadcastReceipt({ pkgId: 'p', orderId: 1, orderType: 't', bizUniqKey: 'k', txHash: 5 }), /non-string/);
  assert.equal(lifecycleBizType({ type: '200' }), 200);
  assert.throws(() => lifecycleBizType({ type: 0 }), /valid type/);
  assert.throws(() => validateLifecyclePreflight({ executeResult: false }), /no error detail returned/);
  assert.doesNotThrow(() => validateLifecyclePreflight({ executeResult: 'false' }));
});

test('refund wallet order status parsing', () => {
  const h = `0x${'ab'.repeat(32)}`;
  assert.equal(refund.parseRefundOrderStatus([{ txStatus: '2' }], null).kind, 'Pending');
  assert.equal(refund.parseRefundOrderStatus({ txStatus: 'failed' }, null).kind, 'Failed');
  assert.deepEqual(refund.parseRefundOrderStatus({ txStatus: 'success', txHash: h }, null), { kind: 'Succeeded', txHash: h });
  assert.deepEqual(refund.parseRefundOrderStatus({ txStatus: 4 }, null), { kind: 'Succeeded', txHash: null });
  assert.equal(refund.parseRefundOrderStatus({ txStatus: 4, txHash: 'bad' }, null).kind, 'Unknown');
  assert.equal(refund.parseRefundOrderStatus({ txStatus: 4, txHash: h }, `0x${'cd'.repeat(32)}`).kind, 'Unknown');
  assert.equal(refund.parseRefundOrderStatus([{}, {}], null).kind, 'Unknown');
});

test('refund journal read / receipt detection', () => {
  const path = refund.pendingStatePath('job-9', 'buyer-9');
  mkdirSync(join(path, '..'), { recursive: true });
  const base = { schemaVersion: 2, jobId: 'job-9', userAgentId: 'buyer-9', snapshotId: 's', operation: 'close-created-subscription', state: 'confirmed',
    pkgId: 'p', orderId: 'o', orderType: 't', bizUniqKey: 'k', updatedAt: 1 };
  writeFileSync(path, JSON.stringify(base));
  const s = refund.readPendingMutation('job-9', 'buyer-9');
  assert.equal(s.journalRevision, 2);
  assert.equal(s.txHash, null);
  assert.equal(refund.hasCreatedSubscriptionCloseReceipt('job-9', 'buyer-9'), true);
  writeFileSync(path, JSON.stringify({ ...base, bizUniqKey: ' ' }));
  assert.equal(refund.hasCreatedSubscriptionCloseReceipt('job-9', 'buyer-9'), false);
  writeFileSync(path, JSON.stringify({ ...base, journalRevision: 4 }));
  assert.throws(() => refund.readPendingMutation('job-9', 'buyer-9'), /does not match this task and identity/);
  writeFileSync(path, '{');
  assert.throws(() => refund.readPendingMutation('job-9', 'buyer-9'), /parse Refund V2 reconciliation state/);
  assert.equal(refund.readPendingMutation('job-none', 'buyer-9'), null);
});

test('refund pending-mutation resolution and provenance predicates', () => {
  const { pendingMutationResolved, directRefundProvenanceMatches, requestRefundProvenanceMatches } = refund._internal;
  const s7 = snapshot(0, 7, '10', { paymentTokenAddress: '0xtoken' });
  const journal = { schemaVersion: 2, journalRevision: 3, jobId: 'job-1', userAgentId: 'buyer-1', operation: 'direct-refund', state: 'broadcast_submitted',
    jobType: 0, trialType: null, pkgId: 'p', orderId: 'o', orderType: 't', bizUniqKey: 'k', txHash: null, accountId: 'a', address: '0xb', chainIndex: '196',
    bizType: 200, originalAmount: '10.0', tokenAddress: '0xTOKEN', tokenSymbol: 'usdt', providerAgentId: 'asp-1', serviceId: 'svc-1', serviceName: 'Audit', paymentMode: 1 };
  assert.equal(directRefundProvenanceMatches(s7, journal), true);
  assert.equal(directRefundProvenanceMatches(s7, { ...journal, chainIndex: '1' }), false);
  assert.equal(pendingMutationResolved({ operation: 'direct-refund' }, snapshot(0, 3, '10')), true);
  assert.equal(pendingMutationResolved({ operation: 'direct-refund' }, snapshot(0, 0, '10')), false);
  assert.equal(pendingMutationResolved({ operation: 'finalize-expired-refund' }, snapshot(0, 0, '10')), true);
  assert.equal(pendingMutationResolved({ operation: 'other' }, snapshot(0, 9, '10')), false);
  const s3 = snapshot(0, 3, '10');
  assert.equal(requestRefundProvenanceMatches(s3, { ...journal, operation: 'request-refund' }), true);
  assert.equal(requestRefundProvenanceMatches(snapshot(0, 6, '10'), { ...journal, operation: 'request-refund', journalRevision: 2 }), false);
});

test('refund error classification walks the anyhow cause chain', async () => {
  const { context } = await import(`${LIB}core/errors.mjs`);
  const { ApiCodeError } = await import(`${LIB}wallet/api.mjs`);
  const { isDefinitiveApiRejection, mutationOutcomeMayBeUnknown } = refund._internal;
  const definitive = context('close result is unknown', new ApiCodeError('51002', 'x', 200));
  assert.equal(isDefinitiveApiRejection(definitive), true);
  assert.equal(mutationOutcomeMayBeUnknown(definitive), true);
  assert.equal(isDefinitiveApiRejection(context('close result is unknown', new ApiCodeError('1', 'x', 500))), false);
  assert.equal(mutationOutcomeMayBeUnknown(context('broadcast failed', new Error('boom'))), true);
  assert.equal(mutationOutcomeMayBeUnknown(new Error('lifecycle endpoint did not return a valid type')), false);
});

test('pick 7/5 oracle on a 32-byte job id', () => {
  assert.deepEqual(subComplete.pickSampleIndices(7, 5, '0x' + 'ab'.repeat(32)), [1, 3, 4, 5, 6]);
  assert.equal(subComplete.fnv1aSeed('job-xyz'), 8125975871129387542n);
});

test('verify_final_refund_event veto rules', () => {
  const ctx = (over = {}) => new PreFetchedTaskContext({ status: 9, jobType: 0, paymentMode: 1, tokenAmount: '5', tokenSymbol: 'USDT', tokenAddress: '0xT',
    userAgentId: '1001', providerAgentId: '2002', providerName: 'ASP', serviceId: 'svc', serviceName: 'Audit', ...over });
  const ev = refund.verifyFinalRefundEvent({}, ctx(), 9, '1001');
  assert.deepEqual(ev, { providerName: 'ASP', providerAgentId: '2002', serviceName: 'Audit', amount: '5', tokenSymbol: 'USDT', txHash: null });
  assert.throws(() => refund.verifyFinalRefundEvent({ refundAmount: '4' }, ctx(), 9, '1001'), /not the full original payment/);
  assert.throws(() => refund.verifyFinalRefundEvent({ code: 'FAILED' }, ctx(), 9, '1001'), /reports failure/);
  assert.throws(() => refund.verifyFinalRefundEvent({}, ctx({ jobType: 1 }), 7, '1001'), /status does not match/);
  assert.throws(() => refund.verifyFinalRefundEvent({}, ctx({ status: 7, jobType: 1 }), 7, '1001'), /lacks an authoritative refund-cause/);
  assert.throws(() => refund.verifyFinalRefundEvent({}, ctx(), 9, '9999'), /not owned/);
  assert.throws(() => refund.verifyFinalRefundEvent({ providerAgentId: '1' }, ctx(), 9, '1001'), /provider does not match/);
  assert.throws(() => refund.verifyFinalRefundEvent(undefined, undefined, 9, '1001'), /fresh authoritative task detail is missing/);
  // Expired(8): event fields are ignored entirely
  assert.equal(refund.verifyFinalRefundEvent({ refundAmount: '1' }, ctx({ status: 8 }), 8, '1001').amount, '5');
});

test('asp-ops: Rust `{:.2}` rounding (ties to even on the exact binary value)', () => {
  // rustc 1.95: 0.125→0.12, 0.375→0.38, 4.125→4.12, 2.5→2.50, 1.005→1.00, 99.995→100.00, -0.001→-0.00, 123456.785→123456.79
  const cases = [[0.125, '0.12'], [0.375, '0.38'], [4.125, '4.12'], [2.5, '2.50'], [1.005, '1.00'], [0, '0.00'], [99.995, '100.00'], [4.625, '4.62'],
    [-0.001, '-0.00'], [1e-7, '0.00'], [123456.785, '123456.79']];
  for (const [x, want] of cases) assert.equal(asp.rustFixed(x, 2), want, String(x));
  assert.equal(asp.rustFixed(2.5, 0), '2');
  assert.equal(asp.rustFixed(4.625, 0), '5');
});

test('asp-ops: subscription info / compaction', () => {
  assert.equal(asp.buildSubscriptionInfo({}), null);
  assert.deepEqual(asp.buildSubscriptionInfo({ supportSubscription: true }), { interval: null, feeAmount: null, supportTrial: false, freeTrial: 0 });
  assert.deepEqual(asp.buildSubscriptionInfo({ subscription: [{ interval: 'week', fee: '1' }, { interval: 'month', fee: '3' }], supportTrial: true, freeTrial: 24 }),
    { interval: 'month', feeAmount: '3', supportTrial: true, freeTrial: 24 });
  assert.deepEqual(asp.buildSubscriptionInfo({ subscriptionInfo: { a: 1 } }), { a: 1 });
  const c = asp.compactServiceForAi({ serviceId: 's', feeAmount: '5', serviceGuide: 'guide', junk: 1 });
  assert.equal(c.serviceGuideHash.length, 71);
  assert.equal(c.feeAmount, '5');
  assert.equal(c.junk, undefined);
  const r = asp.compactTaskServiceSelectResponse({ services: [{ serviceId: 'a', asp: { onlineStatus: 2 } }, { serviceId: 'b', serviceType: 'a2mcp', endpoint: 'https://x' }], hasMore: true });
  assert.equal(r.matchStatus, 'matched');
  assert.deepEqual(r.services.map((s) => s.serviceId), ['b']);
  assert.equal(asp.compactTaskServiceSelectResponse({ services: [{ serviceId: 'a' }] }).matchStatus, 'no_online_service');
  assert.equal(asp.compactTaskServiceSelectResponse({}).matchStatus, 'no_match');
  assert.deepEqual(asp.serviceMatchDataFromStdout(Buffer.from('{"ok":true,"data":{"x":1}}')), { x: 1 });
  assert.deepEqual(asp.serviceMatchDataFromStdout(Buffer.from('{"ok":false,"error":"e"}')), { ok: false, error: 'e' });
});

test('subscription-ops: status copy, filters and device routing', () => {
  assert.equal(subOps.statusName(4), 'DISPUTED');
  assert.equal(subOps.statusName(5), 'UNKNOWN_5');
  assert.equal(subOps.statusLabel(9), 'Refund completed');
  assert.equal(subOps.parseStatusFilter('active'), 1);
  assert.equal(subOps.parseStatusFilter('-1'), -1);
  assert.equal(subOps.parseStatusFilter('42'), 42);
  assert.throws(() => subOps.parseStatusFilter('ACTIV'), /invalid status 'ACTIV': expected a code/);
  assert.equal(subOps.deviceReceives('d1', null, true), true);
  assert.equal(subOps.deviceReceives('d1', ['d2'], true), false);
  assert.equal(subOps.deviceReceives(null, ['d1'], true), false);
  assert.equal(subOps.formatDevicesForHuman(null, 'x'), 'all (default — deviceList is not explicitly configured)');
  assert.equal(subOps.formatDevicesForHuman([], 'x'), 'none (no device receives this subscription)');
  assert.equal(subOps.formatDevicesForHuman(['abcdefghij', 'zz'], 'zz'), 'abcdefgh, zz(this device)');
  assert.deepEqual(subOps.normalizeOptionalStrArray([1, 'a', null]), ['a']);
  assert.deepEqual(subOps.normalizeOptionalStrArray('x'), []);
  assert.equal(subOps.normalizeOptionalStrArray(null), null);
});

test('subscription-ops: typed rows follow serde defaults / errors', () => {
  const page = subOps.decodeSubscriptionList({ list: [{ jobId: 'j', status: 1, trailStartTime: 5, deviceList: null, categoryCodes: ['a', 1] }], total: 1 });
  const row = page.list[0];
  assert.equal(row.trialStartTime, 5);
  assert.equal(row.deviceList, null);
  assert.deepEqual(row.categoryCodes, ['a']);
  assert.equal(row.title, '');
  assert.throws(() => subOps.decodeSubscriptionList({ list: [{ title: null }] }), /invalid type: null, expected a string/);
  assert.throws(() => subOps.decodeSubscriptionList({ list: [{ trialStartTime: 1, trailStartTime: 2 }] }), /duplicate field `trialStartTime`/);
  const v = subOps.subscriptionInfoValue({ ...row, serviceDescription: '' });
  assert.equal('serviceDescription' in v, false);
});

test('subscription-ops: enrich_subscription_detail display fields', () => {
  const d = subOps.enrichSubscriptionDetail({ jobId: 'j', title: 't', description: 'd', status: 1, autoRenew: 0, trialType: 1, trialStartTime: 1700000000,
    trialEndTime: 1700086400, serviceTokenAmount: '3', providerAgentId: 2002, subStartTime: 1700000000, subEndTime: '1700086400', deviceList: [] },
  'dev', true, { providerName: 'ASP', tokenSymbol: 'USDT', supportsTrial: true, trialHours: undefined });
  assert.equal(d.freeTrialLabel, '1-day free trial. The first subscription fee of 3 USDT will be charged at 2023-11-15 22:13 (UTC+00:00).');
  assert.equal(d.autoRenewLabel, 'Disabled');
  assert.equal(d.billingPeriodLabel, 'Trial Period');
  assert.equal(d.serviceProviderLabel, 'ASP (2002)');
  assert.equal(d.receiveOnThisDeviceLabel, 'Do not receive');
  assert.equal(d.currentPeriodLabel, '2023-11-14 22:13 (UTC+00:00)–2023-11-15 22:13 (UTC+00:00)');
  assert.deepEqual(d.displayMissingFields, []);
  const free = subOps.enrichSubscriptionDetail({ status: 1, trialType: 0, serviceTokenAmount: '0' }, null, false, { supportsTrial: false });
  assert.equal(free.feeLabel, 'Free');
  assert.equal(free.freeTrialLabel, 'Free trial is not supported.');
  assert.deepEqual(free.displayMissingFields, ['Job ID', 'Job Name', 'Job Description', 'Service Provider', 'Current Period']);
});

test('subscription-list: cursor encoding (spec example) and validation', () => {
  const c = { version: 1, stage: 'ended', page: 2, offset: 3, pageSize: 10, activeCount: 11, endedCount: 12 };
  const enc = subList.encodeCursor(c);
  assert.equal(enc, 'eyJ2ZXJzaW9uIjoxLCJzdGFnZSI6ImVuZGVkIiwicGFnZSI6Miwib2Zmc2V0IjozLCJwYWdlX3NpemUiOjEwLCJhY3RpdmVfY291bnQiOjExLCJlbmRlZF9jb3VudCI6MTJ9');
  assert.deepEqual(subList.decodeCursor(enc), c);
  assert.throws(() => subList.decodeCursor('not-a-cursor'), /invalid subscription cursor/);
  assert.throws(() => subList.decodeCursor(subList.encodeCursor({ ...c, page: 0 })), /invalid subscription cursor/);
  assert.throws(() => subList.decodeCursor(subList.encodeCursor({ ...c, version: 2 })), /invalid subscription cursor/);
  assert.throws(() => subList.decodeCursor(Buffer.from('{"version":1}').toString('base64url')), /invalid subscription cursor/);
});

test('subscription-list: page parsing and actions', () => {
  assert.throws(() => subList.parsePage([], 'active'), /must be a JSON object/);
  assert.throws(() => subList.parsePage({ total: 1, page: 1, pageSize: 1 }, 'active'), /missing list array/);
  assert.throws(() => subList.parsePage({ total: 1, pageSize: 1, list: [] }, 'active'), /missing numeric page$/);
  const p = subList.parsePage({ total: 3, page: 1, pageSize: 2, list: [{ jobId: 'a', status: 0, autoRenew: 1 }, { jobId: 'b', status: 1, autoRenew: 1, subEndTime: 1700000000, deviceList: [] }] }, 'active');
  assert.equal(p.hasNext, true);
  assert.equal(p.items[0].nextChargeLabel, 'Pending acceptance');
  assert.equal(p.items[1].nextChargeAt, '2023-11-14 22:13 (UTC+00:00)');
  assert.equal(p.items[1].hasNoReceivingDevices, true);
  const acts = subList.subscriptionActions(p.items, 'cur', 2);
  assert.deepEqual(acts.map((a) => [a.id, a.recommend]), [['manage_subscription_devices', true], ['view_subscription_detail', false], ['cancel_subscription', false], ['next_subscription_page', false]]);
  assert.deepEqual(subList.subscriptionActions([], 'cur', 2).map((a) => [a.id, a.recommend]), [['next_subscription_page', true]]);
});

test('v2 sampling: FNV-1a seed + LCG partial Fisher-Yates (rustc oracle)', () => {
  assert.deepEqual(subComplete.pickSampleIndices(0, 5, 'x'), []);
  assert.deepEqual(subComplete.pickSampleIndices(3, 5, 'x'), [0, 1, 2]);
  assert.deepEqual(subComplete.pickSampleIndices(20, 5, 'job-100'), [1, 9, 14, 15, 19]);
  assert.deepEqual(subComplete.pickSampleIndices(10, 3, 'job-abc'), [1, 5, 7]);
  assert.deepEqual(subComplete.pickSampleIndices(100, 5, 'job-xyz'), [2, 9, 39, 47, 87]);
  assert.equal(subComplete.fnv1aSeed('job-100'), 17742437602524820518n);
  assert.equal(subComplete.buildDeliverableSample('0x' + '00'.repeat(32)), 'Deliverables: none found.\n');
});

test('v2 results: complete / reject / notification / job completed', () => {
  assert.equal(stringify(complete.submittedResult('j', 'pending')), '{"decision":"ready","nextAction":[{"id":"stop"}],"payload":{"jobId":"j","txHash":"pending"},"phase":"deliverable_review","reason":"completion_submitted"}');
  assert.equal(stringify(reject.reasonRequiredResult('j', 'a', 's')),
    '{"decision":"requires_user_input","nextAction":[{"id":"request_rejection_reason","params":{"agentId":"a","jobId":"j","shortJobId":"s"},"recommend":true}],"payload":{"requiredParams":["reason"]},"phase":"deliverable_review","reason":"rejection_reason_required"}');
  assert.throws(() => reject.validateRejectionReason('  '), /--reason is required for reject/);
  assert.throws(() => reject.validateRejectionReason('x'.repeat(2001)), /exceeds 2000 characters/);
  assert.equal(stringify(notification.subAspClaimNotify('j')), '{"decision":"ready","nextAction":[{"id":"stop"}],"payload":{"event":"sub_asp_claim_notify","jobId":"j","role":"user"},"phase":"notification","reason":"notification_not_required"}');
  const t = new PreFetchedTaskContext({ title: '', tokenAmount: '5', tokenSymbol: 'USDT', paymentMode: 3 });
  assert.equal(jobCompleted.completionNotification('j', t, false), '[onchainos:task-terminal] [x402 Job Completed] Task (`j`) — all steps complete.\n- Spent: 5 USDT\n- Payment: x402');
});

test('v2 create helpers: confirmation parsing', () => {
  assert.equal(caf.normalizeExpiredAt(4102444800), '2100-01-01T00:00:00+00:00');
  assert.equal(caf.normalizeExpiredAt('2030-01-01T00:00:00Z'), '2030-01-01T00:00:00Z');
  assert.throws(() => caf.normalizeExpiredAt('soon'), /missing or invalid expiredAt/);
  assert.throws(() => caf.parseConfirmation({ jobId: ' ' }), /createAndFundConfirmStatus response missing jobId/);
  assert.throws(() => caf.validateCreateResponse('j', { jobId: 'k' }), /returned jobId k, expected j/);
  assert.throws(() => caf.validateCreateResponse('j', { jobId: 'j', uopData: {}, type: 1 }), /unexpected bizType 1; expected 201/);
  assert.throws(() => cs.parseConfirmation({}, false), /empty terms/);
  assert.throws(() => cs.parseConfirmation({ a: 1, typedData: {} }, false), /missing typedData/);
  assert.deepEqual(cs.parseConfirmation({ a: 1, typedData: { x: 1 }, useTrial: true }, false), [{ a: 1, useTrial: true }, { x: 1 }, true]);
  assert.throws(() => cs.validateCreateResponse({ jobId: ' j ', uopData: {}, type: 201 }), /expected 204/);
  assert.equal(stringify(cs.buildConfirmBody({ serviceId: 's', autoRenew: 1, useTrial: false, providerAgentId: 'p' })), '{"autoRenew":1,"providerAgentId":"p","serviceId":"s","subId":0,"useTrial":false}');
});

// flow.rs::notify_and_end_with_deposit — the only volatile part is the QR PNG name
// (`onchainos-funding-qr-<pid>-<nanos>.png`), which is why sub_renew's low-balance branch is
// pinned here rather than by a byte-exact parity case.
test('flow: notify_and_end_with_deposit template and Common QR output', () => {
  const dir = join(HOME, 'funding-qr');
  const prev = process.env.ONCHAINOS_FUNDING_IMAGE_DIR;
  process.env.ONCHAINOS_FUNDING_IMAGE_DIR = dir;
  try {
    const addr = '0xd825f780e3cb88b383907ff427495d1dca352d44';
    const out = flow.notifyAndEndWithDeposit('[⚠️ Renewal Failed] X', addr);
    const lines = out.split('\n');
    assert.deepEqual(lines.slice(0, 7), [
      '**Localize first** — rewrite the content below in the user\'s language before sending. Do NOT pass the English template verbatim to a non-English user.',
      '```bash', 'onchainos agent user-notify --content "<localized content shown below>"', '```',
      'Content: [⚠️ Renewal Failed] X', '', `Deposit address: ${addr} (XLayer)`,
    ]);
    assert.ok(lines[7].startsWith('Common QR output: {"requestedFormat":"auto","resolvedFormat":"png","displayMode":"image-notify","imagePath":'));
    const qr = JSON.parse(lines[7].slice('Common QR output: '.length));
    assert.match(qr.imagePath, /onchainos-funding-qr-\d+-\d+\.png$/);
    assert.equal(qr.mimeType, 'image/png');
    assert.deepEqual(qr.notifyCommandArgs, ['onchainos', 'agent', 'user-notify', '--content', '<localized content>', '--image-path', qr.imagePath]);
    assert.deepEqual(lines.slice(8), [
      'Keep all 4 options and the address. Preserve the existing QR behavior using the returned fields: TTY renders `terminalQr`; non-TTY runs `notifyCommandArgs` and renders `markdownImage`. Put the QR immediately after the deposit address. If the QR fields are absent, show the address and do not claim a QR is scannable. Keep `--content` text-only: no local image path in the content itself.',
      '', 'End turn after the call.', '',
    ]);
  } finally {
    if (prev === undefined) delete process.env.ONCHAINOS_FUNDING_IMAGE_DIR; else process.env.ONCHAINOS_FUNDING_IMAGE_DIR = prev;
  }
});

test('flow: notify helpers and pure playbooks', async () => {
  assert.equal(flow.notifyAndEnd('X'), '**Localize first** — rewrite the content below in the user\'s language before sending. Do NOT pass the English template verbatim to a non-English user.\n```bash\nonchainos agent user-notify --content "<localized content shown below>"\n```\nContent: X\n\nEnd turn after the call.\n');
  assert.ok(flow.notifyAndEndTerminal('X', 'HINT').includes('--content "[onchainos:task-terminal] <localized content shown below>"'));
  const j = '0x' + 'ab'.repeat(32);
  const cli = await flow.generateNextAction(j, 'user_decision_cli_failed', '1001', null, ' retry ', null, null, { event: 'user_decision_cli_failed' });
  assert.ok(cli.startsWith('**Core rules:**'));
  assert.ok(cli.includes("user's verbatim reply: `retry`"));
  const staked = await flow.generateNextAction(j, 'staked', '1001', null, null, null, null, {});
  assert.ok(staked.endsWith(`[Unknown Status] staked\n[Advice]\n1. Call \`onchainos agent common context ${j} --role user\` to view full context\n2. If this status is not part of the expected flow, wait for user instructions\n3. Do not predict / assume other notifications\n`));
  const claim = await flow.generateNextAction(j, 'sub_asp_claim_notify', '1001', null, null, null, null, {});
  assert.ok(claim.startsWith('{"decision":"ready"'));
  const regular = await flow.generateNextAction('', 'create_task', '1001', null, null, null, null, { branch: 'regular' });
  assert.ok(regular.startsWith('[Current Operation] Publish task — regular branch\n'));
  assert.ok(regular.includes("--service-params '<confirmed JSON object or {}>'"));
  const actions = flow.availableActions('submitted', 'J');
  assert.equal(actions.length, 5);
});

test('flow-lifecycle: deliver frame parsing and transport identity', () => {
  const file = 'jobId: 0x1\ndeliverableType: file\nfileKey: k\ndigest: d\nsalt: s\nnonce: n\nsecret: x\nfilename: a.txt\n[intent:deliver]\n';
  assert.deepEqual(core.parseDeliverContent(file), { kind: 'file', fileKey: 'k', digest: 'd', salt: 's', nonce: 'n', secret: 'x', filename: 'a.txt' });
  assert.equal(core.parseDeliverContent(file.replace('secret: x\n', '')), undefined);
  assert.deepEqual(core.parseDeliverContent('jobId: 1\ndeliverableType: text\n- - -\n hello \n- - -\n[intent:deliver]'), { kind: 'text', text: 'hello' });
  assert.equal(core.parseDeliverContent('deliverableType: text\n- - -\n  \n- - -\n[intent:deliver]'), undefined);
  assert.equal(core.parseDeliverContent('deliverableType: text\n- - -\nhi\n'), undefined);
  assert.deepEqual(core.a2aTransportIdentityFromJson({ message: { messageId: ' m-1 ' }, sessionKey: 'sk' }), { value: 'm-1', source: 'transport_id', originSessionKey: 'sk' });
  const h = core.a2aTransportIdentityFromJson({ b: 1, a: [true, null, 'x'] });
  assert.equal(h.source, 'envelope_hash');
  assert.match(h.value, /^[0-9a-f]{64}$/);
  assert.equal(core.a2aTransportIdentityFromJson({ a: [true, null, 'x'], b: 1 }).value, h.value); // JCS: key order irrelevant
  assert.match(core.modelDeliveryId('j', 'p', '/nonexistent', { source: 'transport_id', value: 'm-1' }), /^msg:[0-9a-f]{64}$/);
});

test('flow-lifecycle: terminal / subscription notices from fresh context', async () => {
  const hint = 'HINT';
  const base = { jobId: 'J', agentId: '1001', shortId: 'J', titleDisplay: '<title>', titleQueryHint: '', titleInExtract: '', terminalSessionHint: hint, paymentMode: 1, data: null };
  const settled = terminal.jobRefunded({ ...base, prefetched: new PreFetchedTaskContext({ status: 9, jobType: 0, paymentMode: 1, tokenAmount: '5', tokenSymbol: 'USDT',
    tokenAddress: '0xT', userAgentId: '1001', providerAgentId: '2002', providerName: 'ASP', serviceName: 'Audit', title: 'Report' }) }, {});
  assert.ok(settled.includes('Content after the marker: [Refund Settled] Report (`J`)\n- Refund ASP: ASP (2002)\n- Service: Audit\n- Refund amount: 5 USDT\n- Tx Hash: unavailable\n'));
  assert.ok(settled.endsWith('HINT\n'));
  const incomplete = terminal.jobRefunded({ ...base, prefetched: null }, {});
  assert.ok(incomplete.includes('[Refund Settlement Detail Incomplete] Task title unavailable (`J`)'));
  const closedFree = terminal.jobClosed({ ...base, prefetched: new PreFetchedTaskContext({ status: 7, jobType: 0, tokenAmount: '0', userAgentId: '1001', title: 'T' }) }, {});
  assert.ok(closedFree.includes('[Job Closed] T (`J`) has been closed. The task price was 0, so no refund was required.'));
  assert.equal(subscription.subExpireWarnRenewalHint(0, 'J'), 'Auto-renewal is **off**. To enable it before expiry:\n```bash\nonchainos agent start-autorenew J\n```');
  assert.equal(subscription.subExpireWarnRenewalHint(null, 'J'), 'No action needed unless you want to cancel.');
});

test('content (via the flow-lifecycle bridge): fmt_epoch and templates', () => {
  assert.equal(content.fmtEpoch(1700000000), '2023-11-14 22:13 UTC');
  assert.equal(content.fmtEpoch(1700000000000), '2023-11-14 22:13 UTC');
  assert.equal(content.fmtEpoch(0), undefined);
  assert.equal(content.subCancelUserNotify('fail', 'busy', 0, 's', 'J', null), '[Subscription Cancellation Failed] Your subscription could not be cancelled.\n         Reason: busy');
  assert.equal(content.subCloseNotifyUserNotify('svc', 'J', null, null, ' '), '[Service Closed] "svc" has ended. Job J status: Closed.');
  assert.equal(content.regularJobAspRejectExpireUserNotify('svc', 'J', '0', 'USDT', null, false),
    '[Refund Request Processed] The ASP did not respond to the refund request for svc by the deadline. No charges were incurred, so no refund is required.\n\nJob ID: J\nASP response deadline: Unavailable\nJob status: Failed');
});

test('legacy a2mcp completion result', () => {
  assert.equal(stringify(complete.legacyA2mcpRemovedResult('j')), '{"decision":"blocked","nextAction":[{"id":"stop"}],"payload":{"jobId":"j"},"phase":"deliverable_review","reason":"legacy_a2mcp_flow_removed"}');
});
