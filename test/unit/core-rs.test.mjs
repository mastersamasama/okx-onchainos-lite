// lib/core/rs — the Rust std / crate semantics every port shares: str, num, serde_json::Value
// accessors, std::fs / std::path / io::Error, chrono, base64 / hex / bs58, serde_jcs, anyhow,
// process and reqwest Display texts. Expected values are rustc 1.95 / crate oracles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = '../../skill/onchainos-lite/lib/';
const str = await import(LIB + 'core/rs/str.mjs');
const num = await import(LIB + 'core/rs/num.mjs');
const value = await import(LIB + 'core/rs/value.mjs');
const fs = await import(LIB + 'core/rs/fs.mjs');
const time = await import(LIB + 'core/rs/time.mjs');
const { B64, hexDecode, bs58Decode, bs58Encode, sha256Hex } = await import(LIB + 'core/rs/codec.mjs');
const { jcs } = await import(LIB + 'core/rs/jcs.mjs');
const { downcast, outermost } = await import(LIB + 'core/rs/anyhow.mjs');
const { exitStatusText, spawnErrorText } = await import(LIB + 'core/rs/process.mjs');
const { ReqwestError, hrefOf } = await import(LIB + 'core/rs/reqwest.mjs');
const { parse, F64 } = await import(LIB + 'core/json.mjs');
const { context } = await import(LIB + 'core/errors.mjs');

const WIN = process.platform === 'win32';
const errMsg = (fn) => { try { fn(); } catch (e) { return e.message; } return undefined; };

// ── str ─────────────────────────────────────────────────────────────

test('str::trim / to_ascii_*: char::is_whitespace and ASCII-only case mapping', () => {
  assert.equal(str.trim('\u0085 x \u3000'), 'x');
  assert.equal(str.trim('\ufeffx'), '\ufeffx');
  assert.equal(str.asciiLower('ÀBC'), 'Àbc');
  assert.equal(str.asciiUpper('ıab'), 'ıAB');
  assert.ok(str.eqIgnoreAsciiCase('0xAbC', '0XaBc'));
  assert.equal(str.byteLen('é✓'), 5);
  assert.equal(str.charCount('é\u{1f600}'), 2);
  assert.deepEqual(str.splitWhitespace(' a\u00a0b\tc '), ['a', 'b', 'c']);
  assert.deepEqual(str.lines('a\r\nb\n\nc\n'), ['a', 'b', '', 'c']);
  assert.equal(str.trimStartMatches('0x0x12', '0x'), '12');
});

test('str::splitn, Vec::sort + dedup in UTF-8 byte order', () => {
  assert.deepEqual(str.splitn('a|b|c|d', 3, '|'), ['a', 'b', 'c|d']);
  assert.deepEqual(str.splitn('a', 3, '|'), ['a']);
  assert.deepEqual(str.sortDedup(['b', 'a', 'b', '\u{10000}', '＀']), ['a', 'b', '＀', '\u{10000}']);
});

test('<str as Debug> / <char as Debug>: escape_debug_ext with grapheme-extended escapes', () => {
  assert.equal(str.strDebug('a"b\n'), '"a\\"b\\n"');
  assert.equal(str.strDebug("it's \\ é"), '"it\'s \\\\ é"');
  assert.equal(str.strDebug('\0\t\r\x7f\u00ad'), '"\\0\\t\\r\\u{7f}\\u{ad}"');
  assert.equal(str.strDebug('a\u200bb\u00a0c\u0301'), '"a\\u{200b}b\\u{a0}c\\u{301}"');   // Cf, Zs ≠ ' ', Grapheme_Extend
  assert.equal(str.charDebug("'"), "'\\''");
  assert.equal(str.charDebug('"'), `'"'`);
  assert.equal(str.charDebug('z'), "'z'");
  assert.equal(str.debugOptStr(undefined), 'None');
  assert.equal(str.debugOptStr('x'), 'Some("x")');
  assert.equal(str.debugOptInt(-1), 'Some(-1)');
});

test('core::str::Utf8Error Display (String::from_utf8 maximal subparts)', () => {
  assert.equal(str.utf8ErrorText(Buffer.from('ok ✓')), undefined);
  assert.equal(str.utf8ErrorText(Buffer.from([0x61, 0xff])), 'invalid utf-8 sequence of 1 bytes from index 1');
  assert.equal(str.utf8ErrorText(Buffer.from([0xe2, 0x9c])), 'incomplete utf-8 byte sequence from index 0');
});

// ── num ─────────────────────────────────────────────────────────────

test('<f64 as FromStr>: Rust grammar, no surrounding whitespace', () => {
  for (const [s, v] of [['1', 1], ['+1.5', 1.5], ['.5', 0.5], ['5.', 5], ['1e3', 1000], ['1E-2', 0.01], ['-0', -0]]) assert.equal(num.parseF64(s), v);
  for (const s of ['inf', 'INFINITY', '+Inf']) assert.equal(num.parseF64(s), Infinity);
  assert.equal(num.parseF64('-inf'), -Infinity);
  assert.ok(Number.isNaN(num.parseF64('NaN')));
  for (const s of ['', '.', 'e5', '1e', ' 1', '0x1', '1_0', 'infinit', '--1', 'Infinityy']) assert.equal(num.parseF64(s), undefined, s);
  assert.equal(num.parseF64(1), undefined);   // not a &str
});

test('integer FromStr: JSON integer forms and ParseIntError texts', () => {
  assert.equal(num.parseU64('+42'), 42);
  assert.equal(num.parseU32('4294967295'), 4294967295);
  assert.equal(num.parseU32('4294967296'), undefined);
  assert.equal(num.parseU64('18446744073709551615'), 18446744073709551615n);
  assert.equal(num.parseU64('18446744073709551616'), undefined);
  for (const s of ['', '+', '-1', '1 ', '١']) assert.equal(num.parseU64(s), undefined, s);
  assert.equal(num.parseI64('-9223372036854775808'), -9223372036854775808n);
  assert.equal(num.parseI64('9223372036854775808'), undefined);
  assert.equal(num.parseI32('-2147483649'), undefined);
  assert.equal(num.parseU128('340282366920938463463374607431768211455'), (1n << 128n) - 1n);
  assert.equal(num.intFromStrOk('7', 'u64'), 7n);
  for (const [s, t, m] of [['', 'u32', 'cannot parse integer from empty string'], ['x', 'u32', 'invalid digit found in string'],
    ['-1', 'u32', 'invalid digit found in string'], ['+', 'i64', 'invalid digit found in string'],
    ['4294967296', 'u32', 'number too large to fit in target type'], ['-9223372036854775809', 'i64', 'number too small to fit in target type']]) {
    assert.equal(errMsg(() => num.intFromStr(s, t)), m, s);
  }
});

test('ruint U256 FromStr, `as u32`, saturating u64 add', () => {
  assert.equal(num.u256FromStr('0x_ff'), 255n);
  assert.equal(num.u256FromStr('0b101'), 5n);
  assert.equal(errMsg(() => num.u256FromStr('0x1g')), 'digit 16 is out of range for base 16');
  assert.equal(errMsg(() => num.u256FromStr('1.5')), 'invalid digit: .');
  assert.equal(errMsg(() => num.u256FromStr(`0x1${'0'.repeat(64)}`)), 'the value is too large to fit the target type');
  assert.equal(num.toU32(2 ** 32 + 5), 5);
  assert.equal(num.u64SaturatingAdd(num.U64_MAX, 1), num.U64_MAX);
  assert.equal(num.jsonInt(2n ** 53n), 2n ** 53n);
  assert.equal(num.jsonInt(5n), 5);
});

test('format!("{:.N}") of f64 rounds the exact binary value half-to-even', () => {
  assert.equal(num.formatFixed(20.25, 1), '20.2');
  assert.equal(num.formatFixed(15.000000000000002, 1), '15.0');
  assert.equal(num.formatFixed(0.125, 2), '0.12');
  assert.equal(num.formatFixed(-0, 2), '-0.00');
  assert.equal(num.formatFixed(NaN, 2), 'NaN');
  assert.equal(num.formatFixed(-Infinity, 1), '-inf');
  assert.equal(num.fixed1Ratio(1, 4), '0.2');
  assert.equal(num.fixed1Ratio(3, 4), '0.8');
});

// ── serde_json::Value ───────────────────────────────────────────────

test('Value accessors over the lossless JSON representation', () => {
  assert.ok(Object.is(value.asI64(-0), 0));
  assert.equal(value.asU64(-1), undefined);
  assert.equal(value.asU64(2n ** 64n), undefined);
  assert.equal(value.asI64(2n ** 63n), undefined);
  assert.equal(value.asU64(new F64('1.0')), undefined);
  assert.equal(value.asF64(new F64('1.5')), 1.5);
  assert.equal(value.get([7], 0), 7);
  assert.equal(value.get({}, 'toString'), undefined);
  assert.equal(value.at(null, 'x'), null);
  assert.deepEqual(value.setIndex(null, 'k', 1), { k: 1 });
  assert.equal(errMsg(() => value.setIndex([], 'k', 1)), 'cannot access key "k" in JSON array');
  assert.equal(value.numText(-0), '0');
  assert.equal(value.numText(2n ** 64n), '18446744073709551616');
  assert.equal(value.valueText({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
});

// ── base64 0.22 / hex 0.4 / bs58 0.5 ────────────────────────────────

test('base64 0.22 STANDARD: strict canonical decode with the crate error texts', () => {
  assert.deepEqual([...B64.STANDARD.decode('AAECAwQ=')], [0, 1, 2, 3, 4]);
  assert.equal(B64.STANDARD.decode('').length, 0);
  assert.equal(B64.STANDARD.decode('YQ==').toString(), 'a');
  assert.throws(() => B64.STANDARD.decode('YQ'), /^Error: Invalid padding$/);
  assert.throws(() => B64.STANDARD.decode('not-base64'), /^Error: Invalid symbol 45, offset 3\.$/);
  assert.throws(() => B64.STANDARD.decode('AAECAwQ'), /^Error: Invalid padding$/);
  assert.throws(() => B64.STANDARD.decode('AB=='), /^Error: Invalid last symbol 66, offset 1\.$/);
  assert.throws(() => B64.STANDARD.decode('A'), /^Error: Invalid input length: 1$/);
  assert.throws(() => B64.STANDARD.decode('=AAA'), /^Error: Invalid symbol 61, offset 0\.$/);
  assert.throws(() => B64.STANDARD.decode('AA=A'), /^Error: Invalid symbol 61, offset 2\.$/);
  assert.throws(() => B64.STANDARD.decode('AAAAA*'), /^Error: Invalid symbol 42, offset 5\.$/);
});

test('base64 0.22 NO_PAD / URL_SAFE engines', () => {
  assert.throws(() => B64.STANDARD_NO_PAD.decode('YQ=='), /^Error: Invalid padding$/);
  assert.deepEqual([...B64.URL_SAFE_NO_PAD.decode('-_8')], [0xfb, 0xff]);
  assert.equal(B64.URL_SAFE_NO_PAD.encode(Buffer.from([0xfb, 0xff])), '-_8');
  assert.equal(B64.STANDARD.encode(Buffer.from([0xfb, 0xff])), '+/8=');
});

test('hex 0.4 / bs58 0.5 decoders with the crate error texts', () => {
  assert.deepEqual([...hexDecode('0aFF')], [10, 255]);
  assert.throws(() => hexDecode('abc'), /^Error: Odd number of digits$/);
  assert.throws(() => hexDecode('zz'), /^Error: Invalid character 'z' at position 0$/);
  assert.throws(() => hexDecode('0g'), /^Error: Invalid character 'g' at position 1$/);
  assert.deepEqual([...bs58Decode('1112')], [0, 0, 0, 1]);
  assert.throws(() => bs58Decode('0OIl'), /^Error: provided string contained invalid character '0' at byte 0$/);
  assert.throws(() => bs58Decode('aé'), /^Error: provided string contained non-ascii character starting at byte 1$/);
  assert.equal(bs58Encode(Buffer.from('Hello World')), 'JxF12TrwUP45BMd');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ── serde_jcs 0.1 ───────────────────────────────────────────────────

test('serde_jcs: keys in serialized-byte order, ECMAScript numbers, 0.0 → 0', () => {
  assert.equal(jcs(parse('{"b":1.50,"a":[10.0,0.0,1e21],"c":"x"}')), '{"a":[10,0,1e+21],"b":1.5,"c":"x"}');
  assert.equal(jcs({ 'a"': 1, 'a#': 2 }), '{"a#":2,"a\\"":1}');
  assert.equal(jcs({ '\u{10000}': 2, '＀': 1 }), '{"＀":1,"\u{10000}":2}');
  assert.equal(jcs(parse('{"n":18446744073709551615}')), '{"n":18446744073709551615}');
  assert.equal(errMsg(() => jcs(NaN)), 'oh no');
});

// ── std::fs / std::path / io::Error ─────────────────────────────────

test('PathBuf::join as displayed (no normalisation)', () => {
  const sep = WIN ? '\\' : '/';
  assert.equal(fs.pathJoin('base', 'x'), `base${sep}x`);
  assert.equal(fs.pathJoin(`base${sep}`, 'x'), `base${sep}x`);
  assert.equal(fs.pathJoin('base', 'a/b'), `base${sep}a/b`);
  assert.equal(fs.pathJoin('', 'x'), 'x');
  assert.equal(fs.pathJoin('/tmp/h', '/abs'), '/abs');
  if (WIN) {
    assert.equal(fs.pathJoin('C:', 'task'), 'C:task');
    assert.equal(fs.pathJoin('C:\\h', 'D:\\abs'), 'D:\\abs');
    assert.equal(fs.pathJoin('C:\\h', '\\root'), 'C:\\root');
  }
});

test('Path::file_name / extension / file_stem / with_extension', () => {
  assert.equal(fs.fileName('a/b.tar.gz'), 'b.tar.gz');
  assert.equal(fs.extension('a/b.tar.gz'), 'gz');
  assert.equal(fs.fileStem('a/b.tar.gz'), 'b.tar');
  assert.equal(fs.withExtension('a/b.tar.gz', 'json'), 'a/b.tar.json');
  assert.equal(fs.withExtension('a/b.c', ''), 'a/b');
  assert.equal(fs.extension('.hidden'), undefined);
  assert.equal(fs.fileStem('.hidden'), '.hidden');
  assert.equal(fs.fileName('a/b/.'), 'b');
  assert.equal(fs.fileStem('a/..'), undefined);
});

test('io::Error Display, strict UTF-8 reads and create_new', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocl-core-rs-'));
  try {
    const missing = (p) => errMsg(() => fs.readToString(p));
    assert.equal(missing(join(dir, 'nope')), WIN ? 'The system cannot find the file specified. (os error 2)' : 'No such file or directory (os error 2)');
    assert.equal(missing(join(dir, 'no', 'pe')), WIN ? 'The system cannot find the path specified. (os error 3)' : 'No such file or directory (os error 2)');
    const bom = join(dir, 'bom');
    writeFileSync(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    assert.equal(fs.readToString(bom), '\ufeffa');   // Rust keeps a BOM
    writeFileSync(bom, Buffer.from([0x61, 0xff]));
    assert.equal(missing(bom), fs.INVALID_UTF8);
    const once = join(dir, 'once');
    assert.equal(fs.createNew(once, 'x'), true);
    assert.equal(fs.createNew(once, 'y'), false);
    assert.equal(readFileSync(once, 'utf8'), 'x');
    const e = fs.ioError(Object.assign(new Error('raw'), { code: 'EEXIST' }));
    assert.ok(e instanceof fs.IoError);
    assert.equal(e.code, 'EEXIST');
    const plain = new Error('not io');
    assert.equal(fs.ioError(plain), plain);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── chrono 0.4.44 ───────────────────────────────────────────────────

test('DateTime::parse_from_rfc3339 values and ParseError texts', () => {
  const secs = (s) => time.parseFromRfc3339(s).secs;
  assert.equal(secs('2026-01-01T00:00:00Z'), 1767225600n);
  assert.equal(secs('1970-01-01T01:00:00+01:00'), 0n);
  assert.equal(secs('2026-01-01t00:00:00.123456789123z'), 1767225600n);
  assert.equal(secs('2026-01-01T00:00:00−01:00'), 1767229200n);   // U+2212 minus sign
  for (const [s, m] of [['2026-13-01T00:00:00Z', 'input is out of range'], ['2026-02-30T00:00:00Z', 'input is out of range'],
    ['2026-01-01T00:00:00', 'premature end of input'], ['2026-01-01T00:00:00Zx', 'trailing input'],
    ['2026-01-01T00:00:00+24:00', 'input is out of range'], ['2026/01/01T00:00:00Z', 'input contains invalid characters'],
    ['tomorrow', 'premature end of input'], ['x'.repeat(18), 'premature end of input'], ['x'.repeat(19), 'input contains invalid characters'],
    ['2021-02-29T00:00:00Z', 'input is out of range']]) {
    assert.equal(errMsg(() => time.parseFromRfc3339(s)), m, s);
  }
});

test('DateTime<FixedOffset>::from_str (serde form) is relaxed', () => {
  assert.equal(time.dateTimeFromStr('2026-01-01T00:00:00Z'), 1767225600000000000n);
  assert.equal(time.dateTimeFromStr('2026-01-01 08:00:00.5+0800'), 1767225600500000000n);
  assert.equal(time.dateTimeFromStr('2026-02-30T00:00:00Z'), undefined);
});

test('chrono formatting of Utc timestamps', () => {
  assert.equal(time.utcRfc3339(0), '1970-01-01T00:00:00+00:00');
  assert.equal(time.utcRfc3339(2n ** 62n), undefined);   // outside NaiveDateTime
  assert.equal(time.utcNanosSerde(1500000000n), '1970-01-01T00:00:01.500Z');
  assert.equal(time.utcNanosRfc3339(1500000000n), '1970-01-01T00:00:01.500+00:00');
  assert.equal(time.fmtUtcYmdHm(0), '1970-01-01 00:00 (UTC+00:00)');
});

test('tokio::time::timeout_at never rejects', async () => {
  assert.deepEqual(await time.timeoutAt(Promise.resolve(1), Date.now() + 1000), { ok: true, value: 1 });
  const boom = new Error('boom');
  assert.deepEqual(await time.timeoutAt(Promise.reject(boom), Date.now() + 1000), { ok: true, error: boom });
  assert.deepEqual(await time.timeoutAt(new Promise(() => {}), Date.now()), { ok: false });
});

// ── anyhow / process / reqwest ──────────────────────────────────────

test('anyhow downcast through context layers; `{}` is the outermost message', () => {
  class Inner extends Error {}
  const inner = new Inner('inner');
  const wrapped = context('outer', inner);
  assert.equal(downcast(wrapped, Inner), inner);
  assert.equal(downcast(new Error('x'), Inner), undefined);
  assert.equal(outermost(wrapped), 'outer');
  assert.equal(outermost(new Error('plain')), 'plain');
});

test('ExitStatus / spawn failure / reqwest::Error Display', () => {
  assert.equal(exitStatusText(3), WIN ? 'exit code: 3' : 'exit status: 3');
  assert.equal(spawnErrorText({ code: 'ENOENT' }), WIN ? 'program not found' : 'No such file or directory (os error 2)');
  assert.equal(new ReqwestError('error sending request', 'http://x/').message, 'error sending request for url (http://x/)');
  assert.equal(new ReqwestError('builder error').message, 'builder error');
  assert.equal(hrefOf('HTTP://Example.COM'), 'http://example.com/');
  assert.equal(hrefOf('not a url'), 'not a url');
});
