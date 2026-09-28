// JSON shape helpers — upstream agentic_wallet/shared/common/json.rs.
import { valueAsDecimalString } from './amount.mjs';
import { get, isObject } from '../_rust.mjs';

const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// upstream: json.rs::first_data_item — unwraps a single-item array, anything else unchanged.
export const firstDataItem = (value) => (Array.isArray(value) && value.length === 1 ? value[0] : value);

// upstream: json.rs::shell_arg — bare when every byte is [A-Za-z0-9_\-.:/], else single-quoted.
export function shellArg(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_\-.:/]*$/.test(s)) return s;
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

// upstream: json.rs::find_string — first string/u64 under one of `keys`, depth-first
// (object values visited in sorted-key order, as serde_json's BTreeMap iterates).
export function findString(value, keys) {
  if (isObject(value)) {
    for (const k of keys) {
      const found = valueAsDecimalString(get(value, k));
      if (found !== undefined) return found;
    }
    for (const k of Object.keys(value).sort(cmpBytes)) {
      const found = findString(value[k], keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findString(v, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// upstream: json.rs::required_string — non-empty string field or `<source> is missing <key>`.
export function requiredString(value, key, source) {
  const v = get(value, key);
  if (typeof v !== 'string' || v === '') throw new Error(`${source} is missing ${key}`);
  return v;
}
