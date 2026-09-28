// PRIVATE — serde_json::from_value::<T>(Value) for the derive(Deserialize) structs the agent
// ports decode (no line/column in errors; object keys visited in sorted BTreeMap order; missing
// required fields reported in declaration order; `#[serde(alias)]` duplicates rejected; seq-form
// structs supported). Values keep lite's lossless representation (core/json.mjs parse).
import { F64 } from '../core/json.mjs';
import { rustDebugStr, displayF64 } from './_rs.mjs';

export class SerdeError extends Error {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// serde::de::Unexpected Display for a JSON value.
export function unexpected(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return `boolean \`${v}\``;
  if (typeof v === 'string') return `string ${rustDebugStr(v)}`;
  if (v instanceof F64) {
    const x = v.valueOf();
    if (!Number.isFinite(x)) return `floating point \`${displayF64(x)}\``;
    const t = displayF64(x);
    return `floating point \`${t.includes('.') ? t : t + '.0'}\``;
  }
  if (typeof v === 'number' || typeof v === 'bigint') return `integer \`${v}\``;
  if (Array.isArray(v)) return 'sequence';
  return 'map';
}
const invalidType = (v, exp) => new SerdeError(`invalid type: ${unexpected(v)}, expected ${exp}`);
const invalidValue = (v, exp) => new SerdeError(`invalid value: ${unexpected(v)}, expected ${exp}`);

const RANGES = {
  i8: [-128n, 127n], i16: [-32768n, 32767n], i32: [-2147483648n, 2147483647n], i64: [-9223372036854775808n, 9223372036854775807n],
  u8: [0n, 255n], u16: [0n, 65535n], u32: [0n, 4294967295n], u64: [0n, 18446744073709551615n], usize: [0n, 18446744073709551615n],
};
const int = (kind) => ({
  expecting: kind,
  de(v) {
    if (typeof v === 'number' && Number.isInteger(v) || typeof v === 'bigint') {
      const b = BigInt(v);
      const [lo, hi] = RANGES[kind];
      if (b < lo || b > hi) throw invalidValue(v, kind);
      return Number.isSafeInteger(Number(b)) ? Number(b) : b;
    }
    throw invalidType(v, kind);
  },
});

export const S = {
  string: { expecting: 'a string', de(v) { if (typeof v !== 'string') throw invalidType(v, 'a string'); return v; } },
  bool: { expecting: 'a boolean', de(v) { if (typeof v !== 'boolean') throw invalidType(v, 'a boolean'); return v; } },
  f64: {
    expecting: 'f64',
    de(v) {
      if (typeof v === 'number' || typeof v === 'bigint') return Number(v);
      if (v instanceof F64) return v.valueOf();
      throw invalidType(v, 'f64');
    },
  },
  i8: int('i8'), i16: int('i16'), i32: int('i32'), i64: int('i64'), u8: int('u8'), u16: int('u16'), u32: int('u32'), u64: int('u64'), usize: int('usize'),
  value: { expecting: 'any valid JSON value', de: (v) => v },
  ignored: { expecting: 'anything at all', de: () => true },
  option: (t) => ({ expecting: t.expecting, option: true, de: (v) => (v === null ? null : t.de(v)) }),
  vec: (t) => ({
    expecting: 'a sequence',
    de(v) { if (!Array.isArray(v)) throw invalidType(v, 'a sequence'); return v.map((x) => t.de(x)); },
  }),
  map: (t) => ({
    expecting: 'a map',
    de(v) { if (!isObj(v)) throw invalidType(v, 'a map'); const o = {}; for (const k of Object.keys(v).sort(cmp)) o[k] = t.de(v[k]); return o; },
  }),
  // fields: [[name, type, { default?, aliases? }]]; a field "has default" when opts.default is set
  // (a value or a thunk). Option fields without a default are None when missing (map form).
  struct(name, fields) {
    const expecting = `struct ${name}`;
    const byKey = new Map();
    fields.forEach((f, i) => {
      byKey.set(f[0], i);
      for (const a of f[2]?.aliases || []) byKey.set(a, i);
    });
    const dflt = (f) => { const d = f[2]?.default; return typeof d === 'function' ? d() : d; };
    const hasDefault = (f) => f[2] && Object.prototype.hasOwnProperty.call(f[2], 'default');
    return {
      expecting,
      de(v) {
        if (Array.isArray(v)) {
          const out = {};
          fields.forEach((f, i) => {
            if (i < v.length) out[f[0]] = f[1].de(v[i]);
            else if (hasDefault(f)) out[f[0]] = dflt(f);
            else throw new SerdeError(`invalid length ${i}, expected ${expecting} with ${fields.length} element${fields.length === 1 ? '' : 's'}`);
          });
          if (v.length > fields.length) throw new SerdeError(`invalid length ${v.length}, expected fewer elements in array`);
          return out;
        }
        if (!isObj(v)) throw invalidType(v, expecting);
        const got = new Map();
        for (const k of Object.keys(v).sort(cmp)) {
          if (!byKey.has(k)) continue;
          const i = byKey.get(k);
          if (got.has(i)) throw new SerdeError(`duplicate field \`${fields[i][0]}\``);
          got.set(i, fields[i][1].de(v[k]));
        }
        const out = {};
        fields.forEach((f, i) => {
          if (got.has(i)) out[f[0]] = got.get(i);
          else if (hasDefault(f)) out[f[0]] = dflt(f);
          else if (f[1].option) out[f[0]] = null;
          else throw new SerdeError(`missing field \`${f[0]}\``);
        });
        return out;
      },
    };
  },
};

// serde_json::from_value::<T>(v)
export const fromValue = (t, v) => t.de(v === undefined ? null : v);
