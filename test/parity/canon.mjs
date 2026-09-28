// Canonical form of an HTTP request so two clients' traffic can be compared.
// Volatile values (timestamps, signatures, nonces) are masked by rules; the
// masking list is data, kept in one place and extended per case when needed.

export const VOLATILE_HEADERS = new Set(['host', 'content-length', 'connection']);
export const MASK_HEADERS = new Set(['authorization', 'ok-access-timestamp', 'ok-access-sign', 'x-request-id', 'traceparent']);

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

export function canonicalRequest({ method, url, headers, body }) {
  const u = new URL(url, 'http://x');
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = query[k] === undefined ? v : [].concat(query[k], v);
  let parsed = null, raw = null;
  const text = body && body.length ? body.toString('utf8') : '';
  if (text) {
    try { parsed = JSON.parse(text); } catch { raw = text; }
  }
  const hdrs = {};
  for (const [k, v] of Object.entries(headers || {})) hdrs[k.toLowerCase()] = v;
  return { method, path: u.pathname, query: sortDeep(query), body: parsed !== null ? sortDeep(parsed) : raw, headers: hdrs };
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Mask one path. Segments are resolved greedily against existing keys so keys that
// contain dots work ("home" masks such as payment_cache.json.updated_at, where
// "payment_cache.json" is one key). '*' matches every key / array index at that level.
function maskAt(node, parts) {
  if (!parts.length || node == null || typeof node !== 'object') return;
  if (parts[0] === '*') {
    for (const k of Object.keys(node)) {
      if (parts.length === 1) node[k] = '<masked>';
      else maskAt(node[k], parts.slice(1));
    }
    return;
  }
  for (let j = parts.length; j >= 1; j--) {
    if (parts.slice(0, j).includes('*')) continue;
    const key = parts.slice(0, j).join('.');
    if (own(node, key)) {
      if (j === parts.length) node[key] = '<masked>';
      else maskAt(node[key], parts.slice(j));
      return;
    }
  }
}

// masks: ["query.t", "body.timestamp", "body.*.signature", "payment_cache.json.updated_at"]
export function applyMasks(value, masks = []) {
  const v = structuredClone(value);
  for (const m of masks) maskAt(v, m.split('.'));
  return v;
}

// State-file objects that upstream writes from a Rust HashMap (iteration order is random
// per process): compared order-insensitively. Paths use the same greedy resolution.
export const HASHMAP_PATHS = [
  'wallets.json.accountsMap', 'balance_cache.json.accounts', 'balance_cache.json', 'payment_cache.json.endpoints',
  'cache.json', 'subscriptions.json',
];
// Wall-clock fields in state files, masked for every case.
export const DEFAULT_HOME_MASKS = [
  'payment_cache.json.updated_at', 'chain_cache.json.updated_at', 'balance_cache.json.*.updated_at',
  'doh-cache.json',
];

export function sortKeysAt(value, paths = HASHMAP_PATHS) {
  const v = structuredClone(value);
  const sortObj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) : o);
  const visit = (node, parts) => {
    if (node == null || typeof node !== 'object') return;
    for (let j = parts.length; j >= 1; j--) {
      const key = parts.slice(0, j).join('.');
      if (own(node, key)) {
        if (j === parts.length) node[key] = sortObj(node[key]);
        else visit(node[key], parts.slice(j));
        return;
      }
    }
  };
  for (const p of paths) visit(v, p.split('.'));
  return v;
}

// Score how well a recorded request matches a live one (>=100 = acceptable).
export function matchScore(a, b) {
  if (a.method !== b.method || a.path !== b.path) return -1;
  let s = 100;
  if (JSON.stringify(a.query) === JSON.stringify(b.query)) s += 50;
  if (JSON.stringify(a.body) === JSON.stringify(b.body)) s += 50;
  return s;
}

export function comparableRequest(r, masks = []) {
  const headers = {};
  for (const [k, v] of Object.entries(r.headers || {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (VOLATILE_HEADERS.has(k)) continue;
    headers[k] = MASK_HEADERS.has(k) || String(v).startsWith('<redacted') ? '<present>' : v;
  }
  return applyMasks({ method: r.method, path: r.path, query: r.query, body: r.body, headers }, masks);
}
