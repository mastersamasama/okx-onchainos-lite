// Verifier regression tests for the agent identity / chat ports. Oracles come from the Rust
// toolchain the upstream binary was built with (rustc 59807616e, serde_json 1.0.149 with the
// `float_roundtrip` feature that upstream's dependency graph enables).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LIB = '../../skill/onchainos-lite/lib';
const { fileName } = await import(`${LIB}/core/rs/fs.mjs`);
const { buildRequest } = await import(`${LIB}/agent/identity/service-match.mjs`);
const { stringify } = await import(`${LIB}/core/json.mjs`);
const U = await import(`${LIB}/agent/identity/utils.mjs`);

// std::path::Path::file_name — the multipart `filename` of `agent upload` / `agent file-upload`.
test('fileName: Unix-style separators on every platform', () => {
  assert.equal(fileName('dir/a.png'), 'a.png');
  assert.equal(fileName('a.png'), 'a.png');
  assert.equal(fileName('./a'), 'a');
  assert.equal(fileName('foo/.'), 'foo');
  assert.equal(fileName('foo/..'), undefined);
  assert.equal(fileName('/'), undefined);
  assert.equal(fileName('.'), undefined);
  assert.equal(fileName(''), undefined);
});

test('fileName: Windows paths split on both separators and skip prefixes (Rust 1.95 oracle)', { skip: process.platform !== 'win32' }, () => {
  const cases = [
    ['C:\\dir\\a.png', 'a.png'], ['dir\\a.png', 'a.png'], ['C:a.png', 'a.png'], ['\\\\srv\\share\\f.png', 'f.png'], ['\\\\srv\\share', undefined],
    ['//srv/share/f.png', 'f.png'], ['C:\\', undefined], ['C:', undefined], ['\\\\?\\C:\\x\\y.txt', 'y.txt'], ['\\\\?\\C:', undefined],
    ['\\\\?\\UNC\\srv\\share\\f', 'f'], ['\\\\.\\COM1', undefined], ['foo\\..', undefined], ['foo\\.', 'foo'], ['C:\\dir\\', 'dir'],
    ['\\\\server', 'server'], ['\\\\?\\x\\a/b', 'a/b'], ['\\\\?\\UNC\\srv', undefined], ['\\\\?\\UNC\\srv\\', undefined], ['\\\\?\\x\\.', undefined],
    ['//?/C:/a', 'a'], ['\\\\?\\C:x', undefined], ['1:a', '1:a'], ['\\\\srv\\\\x', 'x'], ['\\\\.\\x\\y', 'y'], ['\\\\?\\UNC\\srv\\share', undefined],
    ['\\\\?\\x', undefined],
  ];
  for (const [p, want] of cases) assert.equal(fileName(p), want, JSON.stringify(p));
});

// chrono::Local.timestamp_millis_opt(ms).single() — the feedback-list `Date` cell.
test('localDateFromMillis: out-of-range timestamps give no date (chrono None → createdAt fallback)', () => {
  const { localDateFromMillis } = U;
  assert.equal(localDateFromMillis(-8334632851200001n), undefined);   // before DateTime<Utc>::MIN on every platform
  assert.equal(localDateFromMillis(8210298412800000n), undefined);    // after DateTime<Utc>::MAX
  assert.equal(localDateFromMillis(9223372036854775807n), undefined);
  if (process.platform === 'win32') {
    // chrono's Windows Local lookup rejects the first / last UTC year of the range
    assert.equal(localDateFromMillis(-8334601228800001n), undefined);
    assert.notEqual(localDateFromMillis(-8334601228800000n), undefined);
    assert.notEqual(localDateFromMillis(8210266876799999n), undefined);
    assert.equal(localDateFromMillis(8210266876800000n), undefined);
  }
  assert.match(localDateFromMillis(1700000000000n), /^2023-11-1[45]$/);
});

test('buildRequest: amounts keep serde_json Number formatting', () => {
  const body = buildRequest({ keywords: [], minPaymentTokenAmount: '0.10590644906288117', maxPaymentTokenAmount: '9007199254740993.0', limit: 3 });
  assert.equal(stringify(body), '{"limit":3,"maxPaymentTokenAmount":9007199254740992.0,"minPaymentTokenAmount":0.10590644906288117}');
  assert.throws(() => buildRequest({ keywords: [], maxPaymentTokenAmount: '1e99999999999999', limit: 3 }),
    { message: '--max-payment-token-amount must be a valid decimal: invalid number at line 1 column 13' });
});
