// Verifier regression tests for the agent identity / chat ports. Oracles come from the Rust
// toolchain the upstream binary was built with (rustc 59807616e, serde_json 1.0.149 with the
// `float_roundtrip` feature that upstream's dependency graph enables).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LIB = '../../skill/onchainos-lite/lib';
const { fileName } = await import(`${LIB}/agent/identity/_std.mjs`);
const { numberFromStr, buildRequest } = await import(`${LIB}/agent/identity/service-match.mjs`);
const { stringify } = await import(`${LIB}/core/json.mjs`);
const U = await import(`${LIB}/agent/identity/utils.mjs`);
const { fromStr } = await import(`${LIB}/agent/identity/_from-str.mjs`);
const { value } = await import(`${LIB}/watch/_serde.mjs`);

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

// serde_json `Number::from_str` — `agent service-match --min/--max-payment-token-amount`.
test('numberFromStr: values and positioned errors match serde_json (float_roundtrip)', () => {
  const cases = [
    ['5.25', { ok: '5.25' }], ['10.50', { ok: '10.5' }], ['-0', { ok: '-0.0' }], ['1e2', { ok: '100.0' }],
    ['1.', { err: 'EOF while parsing a value at line 1 column 2' }], ['01', { err: 'invalid number at line 1 column 2' }],
    // i32 exponent overflow stops at the overflowing digit; the unconsumed rest trips the trailing check
    ['1e99999999999999', { err: 'invalid number at line 1 column 13' }], ['1e-99999999999999', { ok: '0.0' }],
    ['0.0e99999999999', { ok: '0.0' }], ['0.1e99999999999', { err: 'invalid number at line 1 column 15' }],
    ['1e400', { err: 'number out of range at line 1 column 5' }], ['18446744073709551616', { ok: '1.8446744073709552e+19' }],
    ['-9223372036854775809', { ok: '-9.223372036854776e+18' }], ['0.10590644906288117', { ok: '0.10590644906288117' }],
    ['9007199254740993.0', { ok: '9007199254740992.0' }], ['abc', { err: 'invalid number at line 1 column 1' }],
    ['', { err: 'EOF while parsing a value at line 1 column 0' }], ['1 ', { err: 'invalid number at line 1 column 2' }],
    ['-', { err: 'EOF while parsing a value at line 1 column 1' }], ['1e', { err: 'EOF while parsing a value at line 1 column 2' }],
    ['1.5e+', { err: 'EOF while parsing a value at line 1 column 5' }],
    ['184467440737095516150.5e99999999999', { err: 'invalid number at line 1 column 35' }], ['1\n2', { err: 'invalid number at line 2 column 0' }],
  ];
  for (const [s, want] of cases) {
    let got;
    try { got = { ok: stringify(numberFromStr(s)) }; } catch (e) { got = { err: e.message }; }
    assert.deepEqual(got, want, JSON.stringify(s));
  }
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

// serde_json::from_str::<Value> number paths used by --service / --routing-json / --params-json.
test('_from-str: exponent overflow stops at the overflowing digit (serde_json oracle)', () => {
  const cases = [
    ['1e99999999999999', { err: 'number out of range at line 1 column 12' }],
    ['[1e99999999999999]', { err: 'number out of range at line 1 column 13' }],
    ['{"a":0.1e99999999999}', { err: 'number out of range at line 1 column 19' }],
    ['[184467440737095516150.5e99999999999]', { err: 'number out of range at line 1 column 35' }],
    ['1e-99999999999999', { ok: '0.0' }], ['[-0.0e99999999999]', { ok: '[-0.0]' }], ['{"a":1e2147483648}', { err: 'number out of range at line 1 column 17' }],
    ['[0.10590644906288117,9007199254740993.0,-9223372036854775809,18446744073709551615]',
      { ok: '[0.10590644906288117,9007199254740992.0,-9.223372036854776e+18,18446744073709551615]' }],
    ['[01]', { err: 'invalid number at line 1 column 3' }], ['[1.]', { err: 'invalid number at line 1 column 4' }], ['[1e]', { err: 'invalid number at line 1 column 4' }],
  ];
  for (const [s, want] of cases) {
    let got;
    try { got = { ok: stringify(fromStr(s, value)) }; } catch (e) { got = { err: e.message }; }
    assert.deepEqual(got, want, s);
  }
});

test('buildRequest: amounts keep serde_json Number formatting', () => {
  const body = buildRequest({ keywords: [], minPaymentTokenAmount: '0.10590644906288117', maxPaymentTokenAmount: '9007199254740993.0', limit: 3 });
  assert.equal(stringify(body), '{"limit":3,"maxPaymentTokenAmount":9007199254740992.0,"minPaymentTokenAmount":0.10590644906288117}');
  assert.throws(() => buildRequest({ keywords: [], maxPaymentTokenAmount: '1e99999999999999', limit: 3 }),
    { message: '--max-payment-token-amount must be a valid decimal: invalid number at line 1 column 13' });
});
