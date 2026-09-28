// Unit tests for lib/agent/task/common/autotrade/** (autotrade unit). Oracles are the upstream
// Rust #[cfg(test)] cases of autotrade/*.rs where they exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const HOME = mkdtempSync(join(tmpdir(), 'ocl-autotrade-unit-'));
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
const LIB = '../../skill/onchainos-lite/lib/agent/task/common/autotrade/';
const { Decimal, AmountError } = await import(`${LIB}amount.mjs`);
const grants = await import(`${LIB}grants.mjs`);
const tk = await import(`${LIB}trade-kit.mjs`);
const executor = await import(`${LIB}executor.mjs`);
const notify = await import(`${LIB}notify.mjs`);
const guide = await import(`${LIB}guide.mjs`);
const consent = await import(`${LIB}consent.mjs`);
const subscription = await import(`${LIB}subscription.mjs`);
const subscriptionConfig = await import(`${LIB}subscription-config.mjs`);
const tooling = await import(`${LIB}tooling.mjs`);
const card = await import(`${LIB}card.mjs`);
const queue = await import(`${LIB}delivery-queue.mjs`);
const continuation = await import(`${LIB}continuation.mjs`);
const profile = await import(`${LIB}profile.mjs`);
const mod = await import(`${LIB}index.mjs`);
const { fromStr, T } = await import(`${LIB}_serde-json.mjs`);
const { stringify, parse } = await import('../../skill/onchainos-lite/lib/core/json.mjs');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const at = (...p) => join(HOME, 'autotrade', ...p);
const put = (p, content) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content); };
const FAR = 4102444800;

// ── amount.rs ─────────────────────────────────────────────────────────
test('amount: parse rejects bad strings (amount.rs parse_rejects_bad_strings)', () => {
  const kind = (s) => { try { Decimal.parse(s); return 'ok'; } catch (e) { return e.message; } };
  assert.equal(kind(''), AmountError.Empty);
  for (const s of ['.', '1.2.3', '-1', '1e3', '1 000', 'abc', '１']) assert.equal(kind(s), AmountError.Invalid, s);
  assert.equal(kind('9'.repeat(40)), AmountError.Overflow);
});
test('amount: parse accepts and normalises (parse_accepts_valid_strings)', () => {
  const p = (s) => Decimal.parse(s).toPlainString();
  assert.equal(p('0'), '0');
  assert.equal(p('100'), '100');
  assert.equal(p('400.8'), '400.8');
  assert.equal(p('.5'), '0.5');
  assert.equal(p('1.50'), '1.5');
  assert.equal(p('1.'), '1');
  assert.equal(p('007'), '7');
  assert.equal(p('0.0'), '0');
  assert.equal(p('0.000100'), '0.0001');
});
test('amount: percentage / ratio arithmetic oracles', () => {
  assert.equal(Decimal.pctToAbsolute(Decimal.parse('400.8'), Decimal.parse('25')).toPlainString(), '100.2');
  assert.equal(Decimal.pctToAbsolute(Decimal.parse('1'), Decimal.parse('33.333333333')).toPlainString(), '0.33333333');
  assert.equal(Decimal.ratioToAbsolute(Decimal.parse('400.8'), Decimal.parse('0.25')).toPlainString(), '100.2');
  assert.equal(Decimal.pctToRatio(Decimal.parse('12.5')).toPlainString(), '0.125');
});
test('amount: le compares across scales; zero', () => {
  assert.ok(Decimal.parse('100.2').le(Decimal.parse('100.20')));
  assert.ok(Decimal.parse('100.20').le(Decimal.parse('100.2')));
  assert.ok(Decimal.parse('99.999999').le(Decimal.parse('100')));
  assert.ok(!Decimal.parse('100.0001').le(Decimal.parse('100')));
  assert.ok(Decimal.parse('0.0').isZero());
  assert.ok(!Decimal.parse('0.1').isZero());
});

// ── grants.rs ─────────────────────────────────────────────────────────
test('grants: job id charset and venue canonicalisation', () => {
  assert.ok(grants.jobIdIsSafe('job_1-A'));
  for (const j of ['', '../x', 'a.b', 'a b', 'ä']) assert.ok(!grants.jobIdIsSafe(j), j);
  assert.equal(grants.canonicalVenue('hyperliquid'), 'dex');
  assert.equal(grants.canonicalVenue('trade_kit'), 'trade_kit');
  assert.equal(grants.canonicalVenue('DEX'), undefined);
});
test('grants: check_grant validation chain + write_grant round trip', () => {
  const deny = (...a) => { try { grants.checkGrant(...a); return 'allow'; } catch (e) { return e.reason; } };
  assert.equal(deny('../x', 'nasdaq', 'hodl', 'x'), grants.DENY_INVALID_JOB_ID);
  assert.equal(deny('g1', 'nasdaq', 'buy', '1'), grants.DENY_INVALID_VENUE);
  assert.equal(deny('g1', 'dex', 'hold', '1'), grants.DENY_INVALID_ACTION);
  assert.equal(deny('g1', 'dex', 'buy', '0'), grants.DENY_INVALID_AMOUNT);
  assert.equal(deny('g1', 'dex', 'buy', '1'), grants.DENY_NO_GRANT_FILE);
  grants.writeGrant('g1', 'hyperliquid', '100', null, 60);
  const file = JSON.parse(readFileSync(at('grants', 'g1.json'), 'utf8'));
  assert.deepEqual(Object.keys(file), ['version', 'jobId', 'grants', 'createdAt', 'expiresAt']);
  assert.deepEqual(file.grants, { dex: { maxBuy: '100', maxSell: null } });
  assert.equal(deny('g1', 'hyperliquid', 'sell', '999999'), 'allow');
  assert.equal(deny('g1', 'polymarket', 'buy', '1'), grants.DENY_VENUE_NOT_AUTHORIZED);
  assert.throws(() => grants.writeGrant('g1', 'dex', null, null, 60), /at least one of --max-buy/);
  assert.throws(() => grants.writeGrant('g1', 'dex', 'x', null, 60), /--max-buy is not a valid decimal/);
  grants.writeCapGrant('g2', '50', 60);
  const cap = JSON.parse(readFileSync(at('grants', 'g2.json'), 'utf8'));
  assert.deepEqual(Object.keys(cap.grants), ['defi', 'dex', 'polymarket', 'trade_kit']);
  assert.equal(cap.grants.trade_kit.maxSell, '50');
  assert.equal(cap.grants.dex.maxSell, '1000000000000000000');
  put(at('grants', 'g3.json'), JSON.stringify({ version: 1, jobId: 'g3', grants: { dex: {} }, createdAt: 1, expiresAt: FAR, extra: 1 }));
  assert.equal(deny('g3', 'dex', 'buy', '1'), grants.DENY_GRANT_UNREADABLE);
  assert.equal(new grants.GrantDeny(grants.DENY_OVER_CAP).code(), 'over_cap');
});

// ── trade_kit.rs ──────────────────────────────────────────────────────
test('trade kit: version boundary (compatible_version_boundary_is_explicit)', () => {
  const min = tk.MIN_COMPATIBLE_CLI_VERSION;
  assert.ok(!tk.versionAtLeast('1.3.1', min));
  assert.ok(!tk.versionAtLeast('1.3.2-beta.7', min));
  assert.ok(tk.versionAtLeast('1.3.2', min));
  assert.ok(tk.versionAtLeast('v1.3.2+build.9', min));
  assert.ok(tk.versionAtLeast('1.4.3-beta.2', min));
  assert.ok(!tk.versionAtLeast('not-a-version', min));
  assert.ok(tk.versionAtLeast(' vv2.0.0 ', min));
  assert.ok(!tk.versionAtLeast('1.+3.2', min)); // split_once('+') treats it as build metadata
  assert.ok(!tk.versionAtLeast('1.3.+2', min));
  assert.ok(!tk.versionAtLeast('1.3', min));
  assert.ok(!tk.versionAtLeast('1.3.2.1', min));
});
test('trade kit: capability envelope parsing fails closed', () => {
  const s = tk.capabilitySnapshotFromListToolsJson('{"version":"1.4.2","modules":[{"commands":[{"toolName":"market_get_ticker","description":"x"},{"toolName":"spot_place_order"},{"toolName":""}]}],"extra":1}');
  assert.equal(s.version, '1.4.2');
  assert.deepEqual([...s.toolNames].sort(), ['market_get_ticker', 'spot_place_order']);
  for (const bad of ['', '[]', '{"version":"","modules":[]}', '{"version":"1","modules":{}}', '{"version":"1","modules":[{}]}', '{"version":1,"modules":[]}']) {
    assert.throws(() => tk.capabilitySnapshotFromListToolsJson(bad), /trade_kit_capabilities_invalid/, bad);
  }
});
test('trade kit: asset classes / environment / aggregation', () => {
  assert.deepEqual(tk.parseRuntimeAssetClasses(['spot', 'perp', 'spot']), ['spot', 'perp']);
  for (const bad of ['futures', 'options', 'SPOT', 'defi']) assert.throws(() => tk.parseRuntimeAssetClasses([bad]), /asset class must be spot, perp, prediction, or option/);
  assert.throws(() => tk.parseRuntimeAssetClasses([]), /at least one --asset-class is required/);
  assert.equal(tk.TradeEnvironment.parse('demo'), 'demo');
  assert.throws(() => tk.TradeEnvironment.parse('Live'), /environment must be configured, live, or demo/);
  // max_by_key: the LAST maximal check wins
  const r = tk.aggregateResult([{ readiness: 'incompatible', reason: 'upgrade_required' }, { readiness: 'ready', reason: 'ready' }, { readiness: 'incompatible', reason: 'capability_missing' }]);
  assert.deepEqual(r, ['incompatible', 'capability_missing']);
  assert.deepEqual(tk.aggregateResult([]), ['verification_unknown', 'discovery_failed']);
  const out = JSON.parse(stringify(tk.readinessAll(['spot'], 'live', 'missing', 'cli_missing', null)));
  assert.deepEqual(Object.keys(out), ['schemaVersion', 'tool', 'scope', 'authenticationChecked', 'assetClasses', 'environment', 'readiness', 'ready', 'reason', 'checkedAt', 'version', 'missingCapabilities', 'remediation', 'assetChecks']);
  assert.deepEqual(out.remediation, { install: tk.INSTALL_COMMAND });
  assert.match(out.checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(tk.requiredCapabilities('option'), ['option_get_instruments', 'option_get_greeks', 'option_place_order']);
  assert.deepEqual(tk.requiredCapabilities('defi'), []);
});
test('trade kit: split_paths and bounded home probe', () => {
  assert.deepEqual(tk.splitPaths('a;"b;c";;d', 'win32'), ['a', 'b;c', '', 'd']);
  assert.deepEqual(tk.splitPaths('/a:/b', 'linux'), ['/a', '/b']);
  const home = mkdtempSync(join(tmpdir(), 'ocl-tk-home-'));
  assert.equal(tk.probeLocalWith(home, '').cliPath, undefined);
  const name = process.platform === 'win32' ? 'okx.cmd' : 'okx';
  put(join(home, '.local', 'bin', name), 'x');
  assert.equal(tk.probeLocalWith(home, '').cliPath, join(home, '.local/bin', name));
  assert.equal(tk.localReadiness(tk.probeLocalWith(home, '')), tk.LocalReadiness.VerificationUnknown);
});
test('trade kit: evaluate_discovery maps outcomes to typed reasons', () => {
  const reason = (d) => { try { tk.evaluateDiscovery(d); return 'ok'; } catch (e) { return e.reason; } };
  assert.equal(reason({ kind: 'TimedOut' }), 'discovery_timeout');
  assert.equal(reason({ kind: 'Unavailable' }), 'discovery_failed');
  const good = Buffer.from('{"version":"1.4.0","modules":[]}');
  assert.equal(reason({ kind: 'Finished', success: true, stdout: good, stdoutTruncated: false }), 'ok');
  assert.equal(reason({ kind: 'Finished', success: false, stdout: good, stdoutTruncated: false }), 'discovery_failed');
  assert.equal(reason({ kind: 'Finished', success: true, stdout: good, stdoutTruncated: true }), 'discovery_failed');
  assert.equal(reason({ kind: 'Finished', success: true, stdout: Buffer.from([0xff, 0xfe]), stdoutTruncated: false }), 'discovery_failed');
});

// ── executor.rs text helpers ──────────────────────────────────────────
test('executor: safe_text collapses and bounds', () => {
  assert.equal(executor.safeText('  a \t\n b  '), 'a b');
  assert.equal(executor.safeText(' \u3000 '), 'unspecified terminal reason');
  const long = executor.safeText('x'.repeat(300));
  assert.equal([...long].length, 241);
  assert.ok(long.endsWith('…'));
});
test('executor: safe_child_text redaction (child_diagnostics_redact_… oracle)', () => {
  const jwt = `${'a'.repeat(16)}.${'b'.repeat(16)}.${'c'.repeat(16)}`;
  const safe = executor.safeChildText(`apiKey=fixture-api-value --secret fixture-secret-value https://invalid.local?token=fixture-query-value ${jwt} Error: denied`);
  for (const leak of ['fixture-api-value', 'fixture-secret-value', 'fixture-query-value', jwt]) assert.ok(!safe.includes(leak), leak);
  assert.ok(safe.includes('[REDACTED]') && safe.includes('denied'));
  assert.equal(executor.safeChildText('Authorization: Basic abc tail'), 'Authorization:[REDACTED] [REDACTED] [REDACTED] tail');
  assert.equal(executor.safeChildText('bearer tok next'), 'Bearer [REDACTED] next');
  assert.equal(executor.safeChildText('password: hunter2 ok'), 'password:[REDACTED] [REDACTED] ok');
  assert.equal(executor.safeChildText('my_token=abc ok'), 'my_token=[REDACTED] ok');
  assert.equal(executor.safeChildText('line1\nline2\u0007x'), 'line1 line2 x');
});
test('executor: trade kit authentication classification', () => {
  assert.ok(executor.tradeKitAuthenticationError('Error: Failed to spawn okx-auth'));
  assert.ok(executor.tradeKitAuthenticationError('HTTP 401 Unauthorized'));
  assert.ok(executor.tradeKitAuthenticationError('code 50113'));
  assert.ok(!executor.tradeKitAuthenticationError('insufficient balance'));
  assert.equal(executor.failureCategoryFor('trade_kit', 'failed_before_submit', 'Not Logged In'), 'authentication_required');
  assert.equal(executor.failureCategoryFor('okx', 'failed_before_submit', 'not logged in'), null);
  assert.equal(executor.failureCategoryFor('trade_kit', 'unknown_after_submit', 'not logged in'), null);
  assert.ok(executor.safeMetadataToken('agent_direct/okx-cex:1.2', 128));
  assert.ok(!executor.safeMetadataToken('a b', 128));
  assert.ok(!executor.safeMetadataToken('', 128));
  assert.ok(!executor.safeMetadataToken('x'.repeat(129), 128));
});

// ── notify.rs helpers ─────────────────────────────────────────────────
test('notify: short_id / flatten_reason', () => {
  assert.equal(notify.shortId('0x1234567890abcdef1234'), '0x1234…1234');
  assert.equal(notify.shortId('usdc'), 'usdc');
  assert.equal(notify.shortId('x'.repeat(16)), 'x'.repeat(16));
  assert.equal(notify.flattenReason('a\n  b'), 'a b');
  assert.equal([...notify.flattenReason('y'.repeat(301))].length, 301);
});

// ── serde emulation ───────────────────────────────────────────────────
test('serde: positioned errors match serde_json 1.0 wording', () => {
  const err = (s, t) => { try { fromStr(s, t); return 'ok'; } catch (e) { return e.message; } };
  assert.equal(err('[]', T.map(T.value)), 'invalid type: sequence, expected a map at line 1 column 0');
  assert.equal(err('{"a":1', T.map(T.value)), 'EOF while parsing an object at line 1 column 6');
  assert.equal(err('{} x', T.map(T.value)), 'trailing characters at line 1 column 4');
  const S = T.struct('S', [['version', T.u32], ['mode', T.enum('M', [['a', 'a'], ['b', 'b']])]], { denyUnknown: true });
  assert.equal(err('{"version":-1,"mode":"a"}', S), 'invalid value: integer `-1`, expected u32 at line 1 column 13');
  assert.equal(err('{"version":1.5,"mode":"a"}', S), 'invalid type: floating point `1.5`, expected u32 at line 1 column 14');
  assert.equal(err('{"version":1,"mode":"c"}', S), 'unknown variant `c`, expected `a` or `b` at line 1 column 23');
  assert.equal(err('{"version":1,"x":1}', S), 'unknown field `x`, expected `version` or `mode` at line 1 column 16');
  assert.equal(err('{"version":1}', S), 'missing field `mode` at line 1 column 13');
  assert.equal(err('{"version":1,"version":2}', S), 'duplicate field `version` at line 1 column 22');
  const F = T.struct('F', [['a', T.u64]], { flatten: 'rest' });
  assert.deepEqual(fromStr('{"a":1,"z":{"k":2},"z":3}', F), { a: 1, rest: { z: 3 } });
});

// ── guide.rs ──────────────────────────────────────────────────────────
test('guide: parse_draft validation and hash normalisation', () => {
  const src = 'Guide body\n';
  const h = sha(src);
  assert.equal(guide.parseDraft(undefined, undefined), null);
  assert.deepEqual(guide.parseDraft(src, undefined), { source: src, sourceHash: h });
  assert.equal(guide.parseDraft(src, ` sha256:${h.toUpperCase()} `).sourceHash, h);
  assert.throws(() => guide.parseDraft('  ', undefined), /--service-guide must be between 1 and 49152 characters/);
  assert.throws(() => guide.parseDraft('x'.repeat(49153), undefined), /between 1 and 49152/);
  assert.throws(() => guide.parseDraft(src, 'zz'), /--service-guide-hash must be a lowercase SHA-256 hex digest/);
  assert.throws(() => guide.parseDraft(src, sha('other')), /--service-guide-hash does not match --service-guide/);
});
test('guide: sensitive keys and markdown container', () => {
  assert.ok(guide.fieldKeyIsSensitive('my_Access-Token'));
  assert.ok(guide.fieldKeyIsSensitive('JWTvalue'));
  assert.ok(!guide.fieldKeyIsSensitive('tradeAmount'));
  const doc = guide.renderMarkdown('guide', { b: 1, a: 2 }, 'body\n');
  assert.equal(doc, '<!-- onchainos-autotrade:guide\n{\n  "a": 2,\n  "b": 1\n}\n-->\n\nbody\n');
  assert.deepEqual(guide.parseMarkdownDocument('guide', doc, T.value), [{ a: 2, b: 1 }, 'body\n']);
  assert.throws(() => guide.parseMarkdownDocument('consent', doc, T.value), /local autotrade document header is invalid/);
  assert.throws(() => guide.parseMarkdownDocument('guide', '<!-- onchainos-autotrade:guide\n{}', T.value), /^Error: local autotrade document metadata is invalid$/);
});
test('guide: write → consent new → update → snapshot → contract', () => {
  const src = '# Guide\nbody\n';
  const draft = guide.parseDraft(src, undefined);
  guide.writeGuide(guide.draftIntoFile(draft, 'gj', 'svc', 'p1'), draft.source);
  assert.equal(guide.loadGuide('gj').sourceHash, sha(src));
  assert.throws(() => guide.writeGuide({ ...guide.draftIntoFile(draft, 'gj', 'svc', null) }, 'other'), /service guide content does not match its hash/);
  assert.throws(() => guide.createActiveConsentFromGuide('gj', {}, 0), /--ttl-sec must be > 0/);
  assert.throws(() => guide.createActiveConsentFromGuide('gj', { apiKey: 1 }, 5), /credentials must not be stored in Guide Consent: apiKey/);
  const c = guide.createActiveConsentFromGuide('gj', { amount: '1' }, 60);
  assert.equal(c.guideHash, sha(src));
  assert.throws(() => guide.createActiveConsentFromGuide('gj', {}, 60), /active Guide Consent already exists/);
  assert.equal(guide.hasActiveExecutionContract('gj'), true);
  const u = guide.updateActiveConsentValues('gj', { amount: '2' });
  assert.deepEqual(u.values, { amount: '2' });
  assert.equal(stringify(guide.consentSnapshot('gj')), `{"status":"active","guideHash":"${sha(src)}"}`);
  assert.equal(stringify(guide.consentSnapshot('none')), '{"status":"unavailable"}');
  assert.throws(() => guide.updateActiveConsentValues('none', {}), new RegExp(guide.MISSING_CONSENT_RECOVERY_MESSAGE.slice(0, 30)));
  guide.writePreparedConsent('gp', guide.loadGuide('gj'), {}, 60);
  assert.throws(() => guide.updateActiveConsentValues('gp', {}), /active Guide Consent is not available locally/);
  guide.abortPreparedConsent('gp');
  assert.equal(guide.readGuideConsent('gp').lifecycle, 'aborted');
  assert.throws(() => guide.activatePreparedConsent('gp'), /Guide Consent is not prepared/);
});

// ── subscription.rs / subscription_config.rs ──────────────────────────
test('subscription: decide_active exact status and id coercion', () => {
  assert.deepEqual(subscription.decideActive({ status: 1, providerAgentId: 7, serviceId: 's' }), { providerAgentId: '7', serviceId: 's' });
  assert.deepEqual(subscription.decideActive({ status: ' 1 ' }), { providerAgentId: '', serviceId: '' });
  for (const status of [2, '2', 'x', null, parse('1.0'), true]) assert.throws(() => subscription.decideActive({ status }), (e) => e instanceof mod.AutoTradeError && e.value === 'subscription_not_active');
});
test('subscription config: save outcomes and immutability', () => {
  assert.equal(subscriptionConfig.ExecutionMode.fromStr(' guide_direct '), 'guide_direct');
  assert.throws(() => subscriptionConfig.ExecutionMode.fromStr('auto'), /--execution-mode must be signal_only or guide_direct/);
  assert.throws(() => subscriptionConfig.executionMode('a/b', 's'), /invalid subscription AgentId or ServiceId/);
  assert.equal(subscriptionConfig.executionMode('agent', 'svc'), null);
  assert.equal(subscriptionConfig.saveExecutionMode('agent', 'svc', 'signal_only', false), 'created');
  assert.throws(() => subscriptionConfig.saveExecutionMode('agent', 'svc', 'guide_direct', false), /subscription automatic-copy preference is already signal_only; use --replace only after a new user confirmation/);
  assert.equal(subscriptionConfig.saveExecutionMode('agent', 'svc', 'guide_direct', true), 'replaced');
  assert.equal(subscriptionConfig.executionMode('agent', 'svc'), 'guide_direct');
  put(at('subscription-config', 'agent', 'svc2.json'), JSON.stringify({ version: 1, agentId: 'agent', serviceId: 'svc2', executionMode: null, updatedAtMs: 1 }));
  assert.equal(subscriptionConfig.saveExecutionMode('agent', 'svc2', 'signal_only', false), 'repaired');
  const f = JSON.parse(readFileSync(at('subscription-config', 'agent', 'svc2.json'), 'utf8'));
  assert.deepEqual(Object.keys(f), ['version', 'agentId', 'serviceId', 'executionMode', 'updatedAtMs']);
});

// ── consent.rs ────────────────────────────────────────────────────────
test('consent: legacy load / evaluate / quote token', () => {
  const legacy = (job, extra) => put(at('consent', `${job}.json`), JSON.stringify({ version: 6, jobId: job, mode: 'auto', capU: '50', createdAt: 1, expiresAt: FAR, ...extra }));
  legacy('c1', { quoteToken: 'usdc' });
  assert.equal(consent.evaluateConsent('c1', Decimal.parse('50')), consent.ConsentDecision.AutoAllow);
  assert.equal(consent.evaluateConsent('c1', Decimal.parse('50.01')), consent.ConsentDecision.AutoOverCap);
  assert.equal(consent.evaluateConsent('c1', null), consent.ConsentDecision.AutoAllow);
  assert.equal(consent.quoteToken('c1'), 'usdc');
  assert.equal(consent.evaluateConsent('nope', null), consent.ConsentDecision.FirstTime);
  legacy('c2', { mode: 'decline' });
  assert.equal(consent.evaluateConsent('c2', null), consent.ConsentDecision.Declined);
  legacy('c3', { version: 7 });
  assert.throws(() => consent.loadConsent('c3'), (e) => e.code === consent.CONSENT_VERSION_TOO_NEW);
  legacy('c4', { tradeEnvironment: 'configured' });
  assert.throws(() => consent.loadConsent('c4'), (e) => e.code === consent.CONSENT_UNREADABLE);
  legacy('c5', { slippage: '0.5', note: 1.5, serviceGuideHash: 'ABC' });
  const f = consent.loadConsent('c5');
  assert.equal(f.guideHash, 'abc');
  assert.deepEqual(f.dynamicSettings.extra, { note: { label: 'note', type: 'decimal', value: '1.5' } });
  assert.equal(f.dynamicSettings.slippage, '0.5');
  assert.equal(stringify(consent.consentSnapshot('c1')).startsWith('{"status":"active","version":6,"mode":"auto","capU":"50","quoteToken":"usdc","lifecycle"'), false);
  assert.equal(JSON.parse(stringify(consent.consentSnapshot('c1'))).status, 'active');
  assert.equal(stringify(consent.consentSnapshot('c3')), '{"status":"unreadable"}');
});
test('consent: dynamic settings validation', () => {
  assert.doesNotThrow(() => consent.validateDynamicSettings({ tradeAmountMode: 'available_balance_ratio', tradeAmountRatio: '0.5', requiredFields: ['extra.note'], extra: { note: { label: 'Note', type: 'enum', value: 'a', options: ['a', 'b'] } } }));
  assert.throws(() => consent.validateDynamicSettings({ foo: 1 }), /unknown top-level consent setting foo; put service-specific fields under extra/);
  assert.throws(() => consent.validateDynamicSettings({ tradeAmountRatio: '1.5', tradeAmountMode: 'available_balance_ratio' }), /tradeAmountRatio must be greater than 0 and at most 1/);
  assert.throws(() => consent.validateDynamicSettings({ leverage: '3' }), /leverageMode is required when leverage or maxLeverage is present/);
  assert.throws(() => consent.validateDynamicSettings({ extra: { apiKey: { label: 'k', type: 'string', value: 'x' } } }), /invalid or reserved extra consent field: apiKey/);
  assert.throws(() => consent.validateAmountPolicy(null, { tradeAmountMode: 'fixed_amount' }), /tradeAmountU is required when tradeAmountMode=fixed_amount/);
  assert.throws(() => consent.validateRequiredFieldName('bogus'), /unknown required consent field: bogus/);
  const t = { a: 1, extra: { x: 1, y: 2 } };
  consent.mergeDynamicSettings(t, { a: null, extra: { x: null, z: 3 } });
  assert.deepEqual(t, { extra: { y: 2, z: 3 } });
});
test('consent: delivery context register / load / pending pointer / summary', () => {
  const sig = join(HOME, 'sig.txt');
  writeFileSync(sig, 'noise [ACTIONABLE_TRADING_SIGNAL] pre {"signalId":"s-1","params":{"side":"buy","amount":12.5,"quoteCurrency":"USDT","chainIndex":196,"tokenAddress":"  "}} tail');
  const ctx = consent.registerDeliveryContextWithPath('dj', 'ag', 'pv', null, 'd-1', sig, 'trade', 5, 'agent_direct');
  assert.deepEqual(consent.loadDeliveryContext('dj', 'd-1'), ctx);
  assert.throws(() => consent.loadDeliveryContext('dj', 'd.1'), /^Error: invalid delivery id$/);
  assert.throws(() => consent.registerDeliveryContextWithPath('dj', 'ag2', 'pv', null, 'd-1', sig, 'trade', 5, 'agent_direct'), /delivery context identity mismatch/);
  const written = JSON.parse(readFileSync(at('delivery-context', 'dj', 'd-1.json'), 'utf8'));
  assert.deepEqual(Object.keys(written), ['version', 'jobId', 'agentId', 'providerAgentId', 'deliveryId', 'savedPath', 'deliverableType', 'receivedAtMs', 'executionPath']);
  assert.equal(consent.activateDeliveryContextExclusive('dj', 'd-1').kind, 'Activated');
  assert.equal(consent.activateDeliveryContextExclusive('dj', 'd-1').kind, 'AlreadyPending');
  assert.equal(consent.deliveryDecisionSummary(ctx, 'en'), '[Deliverable for this decision]\nDelivery ID: d-1\nSignal ID: s-1\nSignal type: trade\nSide: buy\nSignal amount: 12.5 USDT\nChain: 196');
  assert.equal(consent.pendingDeliveryDecisionSummary('dj', 'zh').split('\n')[0], '[对应交付物]');
  consent.clearPendingDelivery('dj', 'other');
  assert.ok(existsSync(at('pending', 'dj.json')));
  consent.clearPendingDelivery('dj', 'd-1');
  assert.ok(!existsSync(at('pending', 'dj.json')));
  const plain = consent.registerDeliveryContext('dj', 'ag', 'pv', null, 'd2', join(HOME, 'missing.bin'), 'text', 5);
  assert.equal(plain.executionPath, 'legacy_wrapper');
  assert.equal(consent.deliveryDecisionSummary(plain, 'en'), '[Deliverable for this decision]\nDelivery ID: d2\nSignal type: text\nFile: missing.bin');
});

// ── card.rs ───────────────────────────────────────────────────────────
test('card: notify-only / cap adjust decision shapes', () => {
  const n = card.makeNotifyOnly('/tmp/x', 'replay_skip');
  assert.equal(stringify(card.notifyOnlyJson(n)).startsWith('{"autoTrade":true,"executed":false,"savedPath":"/tmp/x","reason":"replay_skip","notificationTemplate":'), true);
  n.notificationPushed = true; n.notificationTemplate = ''; n.guidance = '';
  assert.equal(stringify(card.notifyOnlyJson(n)), '{"autoTrade":true,"executed":false,"savedPath":"/tmp/x","reason":"replay_skip","notificationPushed":true}');
  const d = card.makeCapAdjustDecision('trade', 'cj', 'ag', '100', '50');
  assert.equal(d.deliveryId, 'cap_adjust');
  assert.equal(card.decisionListLabel(d), '[Auto Copy-Trade cap] trade');
  assert.ok(d.userContent.startsWith('[Decision] This 100 U trade succeeded. Raise the future per-trade limit from 50 U to 100 U?'));
  assert.equal(Object.keys(JSON.parse(stringify(card.decisionRequestJson(d)))).join(','), 'autoTrade,executed,decision,deliveryId,signalType,jobId,sourceEvent,userContent,command,guidance');
  const tsel = card.makeToolSelectDecision('d1', 'spot', 'cj', 'ag', ['onchainos', 'trade_kit']);
  assert.ok(tsel.userContent.includes('  A. OnchainOS (`onchainos`)\n  B. Trade Kit (`trade_kit`)\n  C. Skip automatic execution'));
  assert.equal(card.decisionListLabel(card.makePluginInstallDecision('d1', 'spot', 'cj', 'ag', 'polymarket-plugin')), '[Auto Copy-Trade plugin] polymarket-plugin');
});

// ── tooling.rs classifier oracles ─────────────────────────────────────
test('tooling: classify_description oracles', () => {
  const classes = (d) => tooling.classifyDescription(d).classes;
  assert.deepEqual(classes('【Spot Signal】 Buy BTC on-chain, entry 60000, SL 58000'), ['spot']);
  assert.deepEqual(classes('【合约信号】做多 ETH-PERP'), ['perp']);
  assert.deepEqual(classes('DEX swap signal with BUY entry'), ['spot']);
  assert.deepEqual(classes('DEX token-swap signal with BUY entry'), ['spot']);
  assert.deepEqual(classes('BTC-USDT-SWAP signal with LONG entry'), ['perp']);
  assert.deepEqual(classes('Signals for spot, perp, prediction, option, and defi with entry and stop loss'), ['spot', 'perp', 'prediction', 'option', 'defi']);
  assert.deepEqual(classes('Spot market analytics only; no trading signals'), []);
  assert.deepEqual(classes('仅提供行情，不提供交易信号'), []);
  assert.deepEqual(classes('Spotlight on optional features, entry-level guide'), []);
  assert.deepEqual(classes('Smart-contract security alerts and daily risk report'), []);
  assert.deepEqual(classes('智能合约安全信号与漏洞告警'), []);
  assert.deepEqual(classes('合约交易信号：LONG BTC-PERP，入场 60000，止损 59000'), ['perp']);
  assert.deepEqual(classes('【Spot Signal】 is only a format example; no trading signals are provided'), []);
  assert.deepEqual(classes('Event contract signal: BUY YES on the outcome'), ['prediction']);
  assert.deepEqual(classes('Signal: BUY BTC 70000 call, strike 70000, expiry Friday'), ['option']);
  assert.deepEqual(classes('Spot signal from a shared trading pool of ideas, entry'), ['spot']);
  const e = tooling.classifyDescription('【Prediction Signal】 Execute BUY YES event contracts through OKX Event');
  assert.deepEqual(e.explicit, ['trade_kit']);
  assert.ok(e.evidence.includes('prediction:header') && e.evidence.includes('tool:trade_kit'));
});
test('tooling: preflight assembly', () => {
  const inv = new tooling.ToolInventory({ onchainos: 'ready', trade_kit: 'missing', polymarket_plugin: 'missing', hyperliquid_plugin: 'missing' });
  const pf = JSON.parse(stringify(tooling.buildPreflight('Signal: BUY BTC 70000 call, strike 70000, expiry Friday', inv)));
  assert.deepEqual(pf.tradeKitProbe, { mode: 'probe_before_confirmation', assetClasses: ['option'] });
  assert.equal(pf.reminders[0].kind, 'install_plugin');
  assert.equal(pf.reminders[0].messageZh, '运行 npx skills add okx/agent-skills 安装 OKX Agent Skills，并运行 npm install -g @okx_ai/okx-trade-cli 安装 Trade Kit CLI，以执行 option 信号。');
  const multi = JSON.parse(stringify(tooling.buildPreflight('Hyperliquid perp LONG signal, entry 3000 and spot BUY', inv)));
  assert.equal(multi.selectionRequired, true);
  assert.deepEqual(JSON.parse(stringify(tooling.degradedPreflight())).evidence, ['preflight:unavailable']);
  assert.deepEqual(tooling.candidateTools('perp'), ['hyperliquid_plugin', 'trade_kit']);
});

// ── delivery_queue.rs ─────────────────────────────────────────────────
test('delivery queue: FIFO admission, ack protocol, promotion', async () => {
  const sig = join(HOME, 'q.txt');
  writeFileSync(sig, 'x');
  for (const d of ['q1', 'q2']) consent.registerDeliveryContextWithPath('qj', 'ag', 'pv', null, d, sig, 't', 1, 'agent_direct');
  assert.deepEqual((({ kind, alreadyPresent }) => ({ kind, alreadyPresent }))(queue.enqueue('qj', 'q1')), { kind: 'Active', alreadyPresent: false });
  assert.deepEqual(queue.enqueue('qj', 'q2'), { kind: 'Queued', activeDeliveryId: 'q1', position: 2 });
  assert.equal(queue.enqueue('qj', 'q1').alreadyPresent, true);
  assert.ok(existsSync(at('delivery-queue', 'qj.lock')));
  assert.equal(queue.containsDelivery('qj', 'q2'), true);
  assert.equal(queue.acknowledgeResume('qj', 'q2', 2, 1), queue.ResumeAck.NotQueueHead);
  assert.equal(queue.acknowledgeResume('qj', 'q1', 2, 1), queue.ResumeAck.DuplicateOrStale);
  queue.markAwaitingDecision('qj', 'q1');
  assert.throws(() => queue.markAwaitingDecision('qj', 'q2'), /delivery is not the queue head/);
  assert.equal(queue.reconcileTerminal('qj', 'q1'), true);
  const q = JSON.parse(readFileSync(at('delivery-queue', 'qj.json'), 'utf8'));
  assert.equal(q.entries[0].deliveryId, 'q2');
  assert.equal(q.entries[0].state, 'resume_pending');
  assert.equal(queue.acknowledgeResume('qj', 'q2', null, null), queue.ResumeAck.Accepted);
  assert.equal(queue.reconcileTerminal('qj', 'q2'), false);
  assert.ok(!existsSync(at('delivery-queue', 'qj.json')));
  const env = JSON.parse(queue.resumeEnvelope({ agentId: 'ag', jobId: 'qj', deliveryId: 'q2' }, 3));
  assert.deepEqual(Object.keys(env.message), ['code', 'data', 'deliveryId', 'description', 'event', 'jobId', 'resumeAttempt', 'resumeEnvelopeVersion', 'role', 'source', 'timestamp']);
});

// ── executor state machine (local only; okx-a2a absent → notices stay pending) ──
test('executor: report_delivery, finalize and recovery bookkeeping', async () => {
  const saved = join(HOME, 'e.json');
  writeFileSync(saved, '{"signalId":"e"}');
  consent.registerDeliveryContextWithPath('ej', 'ag', 'pv', null, 'e1', saved, 't', 1, 'legacy_wrapper');
  const o = await executor.reportDelivery('ej', 'e1', 'failed_before_execution', '  bad   input ');
  assert.equal(o.reason, 'bad input');
  assert.equal(o.status, 'failed_before_execution');
  assert.ok(existsSync(at('execution-latch', 'ej', 'e1')));
  const again = await executor.reportDelivery('ej', 'e1', 'skipped', 'other');
  assert.equal(again.createdAt, o.createdAt);
  await assert.rejects(() => executor.reportDelivery('ej', 'e1', 'done', 'x'), /delivery report status must be skipped or failed_before_execution/);
  await assert.rejects(() => executor.finalizeDirect('ej', 'e1', 'submitted', 'okx', 'r', null), /delivery is pinned to the legacy execution wrapper/);
  assert.equal(executor.recoveryState('ej', 'e1'), executor.RecoveryState.TerminalOutcome);
  assert.equal(executor.recoveryState('ej', 'nope'), executor.RecoveryState.NoExecution);
  const flushed = await executor.flush('ej');
  assert.equal(flushed.length, 1);
  assert.deepEqual(await executor.flush('none'), []);
  await assert.rejects(() => executor.flush('a/b'), /invalid job id/);
});

// ── continuation.rs / profile.rs / mod.rs ─────────────────────────────
test('continuation: live read, agent binding, expiry deletion', () => {
  const rec = (extra) => JSON.stringify({ version: 5, continuationId: `atc_${'a'.repeat(32)}`, jobId: 'kj', agentId: 'ag', selectedMode: 'auto', origin: 'subscription_restore', signalType: 'trade', requiredFields: ['tradeAmount', 'extra.x'], createdAt: 1, expiresAt: FAR, ...extra });
  put(at('consent-continuation', 'kj.json'), rec({}));
  const f = continuation.loadLiveForJob('kj', 'ag');
  assert.equal(f.draftReviewRequired, true);
  assert.deepEqual(continuation.missingFields(f), ['mode', 'tradeAmount', 'extra.x']);
  assert.throws(() => continuation.loadLiveForJob('kj', 'other'), /consent continuation agent does not match/);
  assert.ok(continuation.continuationIdIsSafe(`atc_${'A'.repeat(32)}`));
  put(at('consent-continuation', 'kj.json'), rec({ expiresAt: 1 }));
  assert.equal(continuation.loadLiveForJob('kj', 'ag'), null);
  assert.ok(!existsSync(at('consent-continuation', 'kj.json')));
});
test('profile: save/load and tool selection', () => {
  const p = profile.saveFromDescription('pj', 'svc', 'prov', 'Hyperliquid perp LONG signal, entry 3000');
  assert.deepEqual(p.assetClasses, ['perp']);
  assert.equal(profile.explicitToolFor('pj', 'perp'), 'hyperliquid_plugin');
  profile.writeSelectedTool('pj', 'perp', 'trade_kit');
  assert.equal(profile.selectedToolFor('pj', 'perp'), 'trade_kit');
  const raw = readFileSync(at('profile', 'pj.json'), 'utf8');
  assert.ok(!raw.includes('\n'));
  assert.throws(() => profile.writeModelRoute('pj', 'perp', 'bad id', null, null, [], 'd1'), (e) => e.code === 'execution_route_invalid');
});
test('mod: retired decision predicates', () => {
  assert.ok(mod.isRetiredModeConfigurationDecision('autotrade_consent'));
  assert.ok(!mod.isRetiredModeConfigurationDecision(undefined));
  assert.ok(mod.isRetiredDeliveryDecision('autotrade_plugin_install'));
  assert.ok(!mod.isRetiredDeliveryDecision('job_submitted'));
  assert.equal(mod.DEFAULT_AUTOTRADE_TTL_SEC, 31536000);
});
