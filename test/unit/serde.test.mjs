// Unit tests: lib/core/serde.mjs — serde_json 1.0.149 / serde_derive 1.0.228 deserialisation.
// Oracles: the upstream onchainos 4.6.3 binary (parity cases) and a serde_json 1.0.149 build
// (float_roundtrip) of the same derive shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const L = '../../skill/onchainos-lite/lib/';
const { T, fromStr, fromSlice, fromValue, firstValue, numberFromStr, unexpected, SerdeError } = await import(L + 'core/serde.mjs');
const { stringify, parse, F64 } = await import(L + 'core/json.mjs');

const err = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

// ── from_str::<Value> ─────────────────────────────────────────────────

test('serde_json::from_str::<Value> error texts and positions (oracle: onchainos 4.6.3 binary)', () => {
  const e = (text) => err(() => fromStr(text));
  assert.equal(e(''), 'EOF while parsing a value at line 1 column 0');
  assert.equal(e('   '), 'EOF while parsing a value at line 1 column 3');
  assert.equal(e('{"code":0,"data":[{"blocked":true}]}x'), 'trailing characters at line 1 column 37');
  assert.equal(e('{"code":"0","data":[{"blocked":true}]'), 'EOF while parsing an object at line 1 column 37');
  assert.equal(e('{\n"code":\n'), 'EOF while parsing a value at line 3 column 0');
  assert.equal(e('{"code":"1","msg":"a\u0001"}'), 'control character (\\u0000-\\u001F) found while parsing a string at line 1 column 21');
  assert.equal(e('{\n  "code": "0",\n  "data": [{"blocked": tru}]\n}'), 'expected ident at line 3 column 27');
  assert.equal(e('{"code":+1}'), 'expected value at line 1 column 9');
  assert.equal(e('[1,]'), 'trailing comma at line 1 column 4');
  assert.equal(e('{"a":1,}'), 'trailing comma at line 1 column 8');
  assert.equal(e('{"a" 1}'), 'expected `:` at line 1 column 6');
  assert.equal(e('{1:2}'), 'key must be a string at line 1 column 2');
  assert.equal(e('"\\ud800"'), 'unexpected end of hex escape at line 1 column 8');
  assert.equal(e('"\\udc00"'), 'lone leading surrogate in hex escape at line 1 column 7');
  assert.equal(e('1e400'), 'number out of range at line 1 column 5');
  assert.equal(e('01'), 'invalid number at line 1 column 2');
  assert.equal(e('['.repeat(128) + ']'.repeat(128)), 'recursion limit exceeded at line 1 column 128');
  // values keep serde_json number identity: -0 is an f64, > u64 is an f64, u64 max is an integer
  assert.ok(fromStr('-0') instanceof F64);
  assert.equal(stringify(fromStr('{"code":-0,"b":18446744073709551616,"c":18446744073709551615,"d":-9223372036854775808}')),
    '{"b":1.8446744073709552e+19,"c":18446744073709551615,"code":-0.0,"d":-9223372036854775808}');
  assert.equal(fromStr('{"a":1,"a":2}').a, 2);                  // Value maps: last duplicate wins
  assert.deepEqual(Object.keys(fromStr('{"__proto__":1}')), ['__proto__']);
});

test('serde_json from_str error positions and messages', () => {
  const e = (s) => err(() => fromStr(s));
  assert.equal(e('nox'), 'expected ident at line 1 column 2');
  assert.equal(e('x'), 'expected value at line 1 column 1');
  assert.equal(e('{"a":1} x'), 'trailing characters at line 1 column 9');
  assert.equal(e('[1,2,]'), 'trailing comma at line 1 column 6');
  assert.equal(e('{"a":'), 'EOF while parsing a value at line 1 column 5');
  assert.equal(e('[01]'), 'invalid number at line 1 column 3');
  assert.equal(e('[1 2]'), 'expected `,` or `]` at line 1 column 4');
  assert.equal(e('"abc'), 'EOF while parsing a string at line 1 column 4');
  assert.equal(e('{\n  "a": tru\n}'), 'expected ident at line 3 column 0');   // upstream-verified (parity case)
  assert.deepEqual(stringify(fromStr('{"b":2.50,"a":1}')), '{"a":1,"b":2.5}');
});

test('exponent overflow stops at the overflowing digit (serde_json oracle)', () => {
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
    try { got = { ok: stringify(fromStr(s)) }; } catch (e) { got = { err: e.message }; }
    assert.deepEqual(got, want, s);
  }
});

test('from_slice validates the UTF-8 of every parsed string, not of ignored ones', () => {
  assert.equal(err(() => fromSlice(Buffer.from([0x22, 0xff, 0x22]))), 'invalid unicode code point at line 1 column 3');
  const S = T.struct('S', [['a', T.string]]);
  const doc = Buffer.concat([Buffer.from('{"a":"x","zz":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.deepEqual(fromSlice(doc, S), { a: 'x' });
  assert.equal(err(() => fromSlice(Buffer.from('﻿{}'))), 'expected value at line 1 column 1');   // a BOM is not whitespace
  assert.deepEqual(firstValue('  {"a":[1]} {"b":2}'), { a: [1] });
  assert.equal(firstValue('   '), undefined);
  assert.equal(firstValue('{"a":'), undefined);
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

// ── from_str::<T> (derive(Deserialize)) ────────────────────────────────

test('serde_json::from_str::<Struct> for state files: document order, seq form, duplicates', () => {
  const INNER = T.struct('Inner', [['a', T.string], ['b', T.bool, false]]);
  const OUTER = T.struct('Outer', [['x', T.string, ''], ['inner', T.vec(INNER), () => []], ['m', T.map(T.i64), () => ({})], ['o', T.option(T.string), null]]);
  const e = (text) => err(() => fromStr(text, OUTER));
  assert.deepEqual(fromStr('[]', OUTER), { x: '', inner: [], m: {}, o: null });
  assert.deepEqual(fromStr('{"inner":[["q"]],"zz":{"deep":[1,{"k":null}]},"o":null}', OUTER), { x: '', inner: [{ a: 'q', b: false }], m: {}, o: null });
  assert.equal(e('{"inner":[{}]}'), 'missing field `a` at line 1 column 12');
  assert.equal(e('{"inner":[[]]}'), 'invalid length 0, expected struct Inner with 2 elements at line 1 column 12');
  assert.equal(e('{"x":"a","x":"b"}'), 'duplicate field `x` at line 1 column 12');
  assert.equal(e('{"m":{"k":9223372036854775808}}'), 'invalid value: integer `9223372036854775808`, expected i64 at line 1 column 29');
  assert.equal(e('{"m":{"k":1.0}}'), 'invalid type: floating point `1.0`, expected i64 at line 1 column 13');
  assert.equal(e('{"m":"a\\n\\u0001\\"b"}'), 'invalid type: string "a\\n\\u{1}\\"b", expected a map at line 1 column 19');
  assert.equal(e('{"zz":[1,2,]}'), 'expected value at line 1 column 12');    // IgnoredAny: no trailing-comma special case
  assert.equal(e('{"x":null}'), 'invalid type: null, expected a string at line 1 column 9');
  assert.equal(e('null'), 'invalid type: null, expected struct Outer at line 1 column 4');
});

test('serde: positioned errors match serde_json 1.0 wording', () => {
  const e = (s, t) => { try { fromStr(s, t); return 'ok'; } catch (x) { return x.message; } };
  assert.equal(e('[]', T.map(T.value)), 'invalid type: sequence, expected a map at line 1 column 0');
  assert.equal(e('{"a":1', T.map(T.value)), 'EOF while parsing an object at line 1 column 6');
  assert.equal(e('{} x', T.map(T.value)), 'trailing characters at line 1 column 4');
  const S = T.struct('S', [['version', T.u32], ['mode', T.enum('M', [['a', 'a'], ['b', 'b']])]], { denyUnknown: true });
  assert.equal(e('{"version":-1,"mode":"a"}', S), 'invalid value: integer `-1`, expected u32 at line 1 column 13');
  assert.equal(e('{"version":1.5,"mode":"a"}', S), 'invalid type: floating point `1.5`, expected u32 at line 1 column 14');
  assert.equal(e('{"version":1,"mode":"c"}', S), 'unknown variant `c`, expected `a` or `b` at line 1 column 23');
  assert.equal(e('{"version":1,"x":1}', S), 'unknown field `x`, expected `version` or `mode` at line 1 column 16');
  assert.equal(e('{"version":1}', S), 'missing field `mode` at line 1 column 13');
  assert.equal(e('{"version":1,"version":2}', S), 'duplicate field `version` at line 1 column 22');
  const F = T.struct('F', [['a', T.u64]], { flatten: 'rest' });
  assert.deepEqual(fromStr('{"a":1,"z":{"k":2},"z":3}', F), { a: 1, rest: { z: 3 } });
  assert.equal(e('[1]', F), 'invalid type: sequence, expected struct F at line 1 column 0');
});

test('derive details: unit variants, aliases, one-field structs, ignored values (serde_json oracle)', () => {
  const KIND = T.enum('Kind', [['alpha', 'alpha'], ['beta_gamma', 'beta_gamma'], ['delta', 'delta']], [['old_delta', 'delta'], ['a_delta', 'delta']]);
  assert.equal(fromStr('{"old_delta":null}', KIND), 'delta');
  assert.equal(err(() => fromStr('{"alpha":1}', KIND)), 'invalid type: integer `1`, expected unit at line 1 column 10');
  assert.equal(err(() => fromStr('"gamma"', KIND)), 'unknown variant `gamma`, expected one of `alpha`, `beta_gamma`, `a_delta`, `delta`, `old_delta` at line 1 column 7');
  assert.equal(err(() => fromStr('1', KIND)), 'expected value at line 1 column 1');
  const STRICT = T.struct('Strict', [['a', T.u32, undefined, ['old']], ['b', T.option(T.i32)]], { denyUnknown: true });
  assert.deepEqual(fromStr('{"old":1}', STRICT), { a: 1, b: null });
  assert.equal(err(() => fromStr('{"a":1,"old":2}', STRICT)), 'duplicate field `a` at line 1 column 12');
  assert.equal(err(() => fromStr('{"a":1,"x":1}', STRICT)), 'unknown field `x`, expected one of `a`, `old`, `b` at line 1 column 10');
  assert.equal(err(() => fromStr('[]', T.struct('One', [['a', T.string]]))), 'invalid length 0, expected struct One with 1 element at line 1 column 2');
  const S = T.struct('S', [['a', T.string]]);
  assert.deepEqual(fromStr('{"a":"x","zz":[1e400,"\\ud800"]}', S), { a: 'x' });   // IgnoredAny only scans
  assert.equal(err(() => fromStr('{"a":"x","zz":"a\tb"}', S)), 'control character (\\u0000-\\u001F) found while parsing a string at line 1 column 16');
  const STR_U64 = T.with(T.string, (s) => { if (!/^[0-9]+$/.test(s)) throw new SerdeError(`bad ${s}`); return Number(s); });
  assert.deepEqual(fromStr('{"n":"7"}', T.struct('N', [['n', STR_U64]])), { n: 7 });
  assert.equal(err(() => fromStr('{"n":"x"}', T.struct('N', [['n', STR_U64]]))), 'bad x at line 1 column 9');
});

// ── from_value::<T> ───────────────────────────────────────────────────

test('serde_json::from_value: key order, seq form, defaults, aliases (serde_json oracle)', () => {
  const BIG = T.struct('Big', [['s', T.string], ['i', T.i64], ['u', T.u32], ['n', T.u64, () => 7], ['f', T.option(T.f64), undefined, ['ff', 'af']]]);
  assert.deepEqual(fromValue(parse('{"s":"x","i":1,"u":2,"zz":1}'), BIG), { s: 'x', i: 1, u: 2, n: 7, f: null });
  assert.deepEqual(fromValue(parse('["x",1,2,5,null]'), BIG), { s: 'x', i: 1, u: 2, n: 5, f: null });
  assert.equal(err(() => fromValue(parse('["x",1,2]'), BIG)), 'invalid length 4, expected struct Big with 5 elements');   // Option needs a default in seq form
  assert.equal(err(() => fromValue(parse('{"s":"x","i":1,"u":2,"f":1,"ff":2}'), BIG)), 'duplicate field `f`');
  assert.equal(err(() => fromValue(parse('{"u":1,"i":1e16}'), BIG)), 'invalid type: floating point `1e+16`, expected i64');   // sorted keys
  assert.equal(err(() => fromValue(parse('{"s":"x","i":1,"u":1.5e-7}'), BIG)), 'invalid type: floating point `1.5e-7`, expected u32');
  assert.equal(err(() => fromValue(parse('{"i":1,"u":2}'), BIG)), 'missing field `s`');
  assert.equal(err(() => fromValue(parse('["x",1]'), BIG)), 'invalid length 2, expected struct Big with 5 elements');
  assert.equal(err(() => fromValue(parse('["x",1,2,3,null,6]'), BIG)), 'invalid length 6, expected fewer elements in array');
  assert.equal(err(() => fromValue(parse('{"a":-129}'), T.struct('I', [['a', T.i8]]))), 'invalid value: integer `-129`, expected i8');
  const FLAT = T.struct('Flat', [['a', T.string]], { flatten: 'extra' });
  assert.deepEqual(fromValue(parse('{"a":"x","q":[1.5],"r":null}'), FLAT), { a: 'x', extra: { q: [new F64('1.5')], r: null } });
  assert.equal(err(() => fromValue(['x'], FLAT)), 'invalid type: sequence, expected struct Flat');
  const KIND = T.enum('Kind', [['alpha', 'alpha'], ['delta', 'delta']]);
  assert.equal(fromValue({ delta: null }, KIND), 'delta');
  assert.equal(err(() => fromValue({ alpha: 1 }, KIND)), 'invalid type: integer `1`, expected unit');
  assert.equal(err(() => fromValue({ alpha: null, delta: null }, KIND)), 'invalid value: map, expected map with a single key');
  assert.equal(err(() => fromValue(1, KIND)), 'invalid type: integer `1`, expected string or map');
  assert.equal(err(() => fromValue('gamma', KIND)), 'unknown variant `gamma`, expected `alpha` or `delta`');
  assert.equal(fromValue(undefined, T.option(T.string)), null);
  assert.equal(fromValue([1, { a: 2 }], T.ignored), true);
});

test('Unexpected: floats in zmij form, strings as Rust {:?}', () => {
  assert.equal(unexpected(new F64(-0)), 'floating point `-0.0`');
  assert.equal(unexpected(18446744073709551615n), 'integer `18446744073709551615`');
  assert.equal(unexpected({}), 'map');
  assert.equal(unexpected('a"b\\c\n\t\r\0'), 'string "a\\"b\\\\c\\n\\t\\r\\0"');
  assert.equal(unexpected('\u0001\u007f ​́é😀 '), 'string "\\u{1}\\u{7f}\\u{a0}\\u{200b}\\u{301}é😀 "');
  assert.equal(unexpected('a"b\\\n\u0001é'), 'string "a\\"b\\\\\\n\\u{1}é"');
  assert.equal(err(() => fromStr('" ​́­"', T.u32)), 'invalid type: string "\\u{a0}\\u{200b}\\u{301}\\u{ad}", expected u32 at line 1 column 11');
});
