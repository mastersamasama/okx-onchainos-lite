// PRIVATE fallback for upstream payment_cache.rs `PaymentCache::{load, save}` with strict serde
// semantics (core/paystate.mjs keeps its own lenient reader for the ApiClient x402 layer; requested
// for promotion into core so both share one implementation).
//   load(): None when the file is missing or does not deserialize as PaymentCache (any field of the
//           wrong type makes the whole cache "absent", exactly like `serde_json::from_slice(..).ok()`).
//   save(): compact struct-order JSON → payment_cache.json.tmp → rename.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homePath, ensureDir } from '../core/home.mjs';
import { parse, stringify, struct } from '../core/json.mjs';
import { context } from '../core/errors.mjs';
import { isObject, asU64 } from '../core/rs/value.mjs';
import { ioErrorText } from '../core/rs/fs.mjs';

const TIER_STATES = ['free', 'charging_unconfirmed', 'charging_confirmed'];
const FIELDS = ['endpoints', 'accepts', 'basic_state', 'premium_state', 'updated_at', 'user_type', 'intro_shown', 'grace_shown', 'default_asset', 'local_signing_warned'];

// upstream: payment_cache.rs::PaymentCache::default
export const defaultCache = () => ({
  endpoints: {}, accepts: null, basic_state: 'free', premium_state: 'free', updated_at: 0,
  user_type: null, intro_shown: false, grace_shown: false, default_asset: null, local_signing_warned: false,
});

const bad = Symbol('bad');
function decodeDefault(v) {
  if (v === null) return null;
  let o = v;
  if (Array.isArray(v)) { if (v.length < 2 || v.length > 3) return bad; o = { asset: v[0], network: v[1], name: v[2] }; }
  if (!isObject(o)) return bad;
  if (typeof o.asset !== 'string' || typeof o.network !== 'string') return bad;
  if (o.name !== undefined && o.name !== null && typeof o.name !== 'string') return bad;
  return { asset: o.asset, network: o.network, name: o.name ?? undefined };
}

// Strict PaymentCache deserialization; returns null when serde would fail.
export function decodeCache(v) {
  let obj = v;
  if (Array.isArray(v)) { if (v.length > FIELDS.length) return null; obj = Object.fromEntries(v.map((x, i) => [FIELDS[i], x])); }
  if (!isObject(obj)) return null;
  const c = defaultCache();
  if (obj.endpoints !== undefined) {
    if (!isObject(obj.endpoints) || Object.values(obj.endpoints).some((x) => typeof x !== 'string')) return null;
    c.endpoints = obj.endpoints;
  }
  if (obj.accepts !== undefined) c.accepts = obj.accepts;
  for (const k of ['basic_state', 'premium_state']) {
    if (obj[k] === undefined) continue;
    if (!TIER_STATES.includes(obj[k])) return null;
    c[k] = obj[k];
  }
  if (obj.updated_at !== undefined) { const u = asU64(obj.updated_at); if (u === undefined) return null; c.updated_at = u; }
  if (obj.user_type !== undefined && obj.user_type !== null) { if (!['new', 'old'].includes(obj.user_type)) return null; c.user_type = obj.user_type; }
  for (const k of ['intro_shown', 'grace_shown', 'local_signing_warned']) {
    if (obj[k] === undefined) continue;
    if (typeof obj[k] !== 'boolean') return null;
    c[k] = obj[k];
  }
  if (obj.default_asset !== undefined) { const d = decodeDefault(obj.default_asset); if (d === bad) return null; c.default_asset = d; }
  return c;
}

export const cachePath = () => homePath('payment_cache.json');

// upstream: payment_cache.rs::PaymentCache::load → cache | null
export function load() {
  const p = cachePath();
  if (!existsSync(p)) return null;
  let data;
  try { data = readFileSync(p); } catch { return null; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; }
  try { return decodeCache(parse(text)); } catch { return null; }
}

// upstream: payment_cache.rs::PaymentCache::save — serde_json::to_vec (struct order, compact).
export function save(c) {
  const p = cachePath();
  ensureDir();
  const body = stringify(struct({
    endpoints: c.endpoints ?? {}, accepts: c.accepts ?? null, basic_state: c.basic_state, premium_state: c.premium_state,
    updated_at: c.updated_at ?? 0, user_type: c.user_type ?? null, intro_shown: !!c.intro_shown, grace_shown: !!c.grace_shown,
    default_asset: c.default_asset ? struct({ asset: c.default_asset.asset, network: c.default_asset.network, name: c.default_asset.name ?? undefined }) : null,
    local_signing_warned: !!c.local_signing_warned,
  }));
  const tmp = p.replace(/\.json$/, '.json.tmp');
  try { writeFileSync(tmp, body); } catch (e) { throw context('write payment cache tmp', new Error(ioErrorText(e))); }
  try { renameSync(tmp, p); } catch (e) { throw context('rename payment cache', new Error(ioErrorText(e))); }
}
