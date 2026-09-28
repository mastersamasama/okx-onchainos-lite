// core/json.mjs parse/stringify follow serde_json 1.0 (acceptance) and serde/ryu (output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, toValue, struct, formatF64, displayF64 } from '../../skill/onchainos-lite/lib/core/json.mjs';

const rt = (s) => stringify(parse(s));

test('numbers: integers exact, floats ryu, -0 is -0.0, out of range rejected', () => {
  assert.equal(rt('{"a":2.0,"b":18446744073709551615,"c":-9223372036854775808,"d":1E5,"e":-0,"f":1e-7}'),
    '{"a":2.0,"b":18446744073709551615,"c":-9223372036854775808,"d":100000.0,"e":-0.0,"f":1e-7}');
  assert.throws(() => parse('1e400'), /number out of range/);
  assert.equal(rt('99999999999999999999'), '1e+20');
});

test('strings: escapes, surrogate pairs, lone surrogates and raw control chars rejected', () => {
  assert.equal(parse('"\\ud83d\\ude00"'), '\u{1F600}');
  assert.throws(() => parse('"\\ud800"'), /hex escape/);
  assert.throws(() => parse('"\\udc00"'), /surrogate/);
  assert.throws(() => parse('"\\u12G4"'), /invalid escape/);
  assert.throws(() => parse('"a\u0001b"'), /control character/);
  assert.equal(stringify('a\u0001\n"\\'), '"a\\u0001\\n\\"\\\\"');
});

test('structure: recursion limit 128, __proto__ is an own key, sorted keys unless struct()', () => {
  assert.doesNotThrow(() => parse('['.repeat(128) + ']'.repeat(128)));
  assert.throws(() => parse('['.repeat(129) + ']'.repeat(129)), /recursion limit/);
  const o = parse('{"__proto__":1,"b":2}');
  assert.equal(Object.keys(o).join(), '__proto__,b');
  assert.equal(stringify(o), '{"__proto__":1,"b":2}');
  assert.equal(stringify({ z: 1, a: 2 }), '{"a":2,"z":1}');
  assert.equal(stringify(struct({ z: 1, a: 2 })), '{"z":1,"a":2}');
  assert.equal(stringify(toValue(struct({ z: 1, a: struct({ y: 2, b: 3 }) }))), '{"a":{"b":3,"y":2},"z":1}');
  assert.throws(() => parse('{"a":1} x'), /trailing characters/);
});

test('f64 formatting matches serde_json (zmij) and Rust Display', () => {
  for (const [x, e] of [[2, '2.0'], [1e16, '1e+16'], [1e-6, '1e-6'], [0.00001, '0.00001'], [-0, '-0.0']]) assert.equal(formatF64(x), e);
  for (const [x, e] of [[50, '50'], [1e21, '1000000000000000000000'], [1e-7, '0.0000001']]) assert.equal(displayF64(x), e);
});
