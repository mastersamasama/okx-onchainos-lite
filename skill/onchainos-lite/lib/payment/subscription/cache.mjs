// Local subId cache for the `period` scheme — upstream payment/subscription/cache.rs.
// $HOME/subscriptions.json: pretty JSON {"by_host": {host: SubscriptionCacheEntry}}; convenience
// index only, never authoritative. (Upstream `by_host` is a HashMap: host order is random there;
// here hosts keep insertion order.)
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { homePath, ensureDir } from '../../core/home.mjs';
import { parse, stringify, struct } from '../../core/json.mjs';
import { context } from '../../core/errors.mjs';
import { asciiLower } from '../../core/_rust-str.mjs';
import { subscriptionCacheEntry } from './types.mjs';
import { isObj, asU64, ioErrorText } from '../_rs.mjs';

// upstream: cache.rs::state_label (private)
export function stateLabel(state) {
  return { 0: 'pending', 1: 'active', 3: 'canceled', 4: 'changed', 2: 'completed' }[state] ?? 'inactive';
}

// upstream: cache.rs::host_of
export function hostOf(url) {
  const s = String(url);
  const i = s.indexOf('://');
  const afterScheme = i >= 0 ? s.slice(i + 3) : s;
  const authority = afterScheme.split(/[/?#]/)[0];
  const at = authority.lastIndexOf('@');
  return asciiLower(at >= 0 ? authority.slice(at + 1) : authority);
}

const ENTRY_FIELDS = ['subId', 'resourceHost', 'merchant', 'planId', 'planTier', 'maxPeriods', 'state', 'changedToSubId'];

// serde derive also accepts a struct in sequence form (`[subId, resourceHost, …]`); only the
// trailing `#[serde(default)] changedToSubId` may be omitted.
function decodeEntry(raw) {
  let e = raw;
  if (Array.isArray(raw)) {
    if (raw.length < ENTRY_FIELDS.length - 1 || raw.length > ENTRY_FIELDS.length) return null;
    e = Object.fromEntries(raw.map((x, i) => [ENTRY_FIELDS[i], x]));
  }
  if (!isObj(e)) return null;
  const s = (k) => (typeof e[k] === 'string' ? e[k] : undefined);
  const tier = asU64(e.planTier), maxp = asU64(e.maxPeriods);
  if ([s('subId'), s('resourceHost'), s('merchant'), s('planId'), s('state')].includes(undefined)) return null;
  if (tier === undefined || tier > 255 || maxp === undefined || maxp > 4294967295) return null;
  if (e.changedToSubId !== undefined && e.changedToSubId !== null && typeof e.changedToSubId !== 'string') return null;
  return { subId: e.subId, resourceHost: e.resourceHost, merchant: e.merchant, planId: e.planId, planTier: tier, maxPeriods: maxp, state: e.state, changedToSubId: e.changedToSubId ?? null };
}

// upstream: cache.rs::SubscriptionCache
export class SubscriptionCache {
  constructor(byHost = new Map()) { this.byHost = byHost; }

  static cachePath() { return homePath('subscriptions.json'); }

  // Missing or corrupt → empty cache.
  static load() {
    const p = SubscriptionCache.cachePath();
    let v;
    try { v = parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(p))); } catch { return new SubscriptionCache(); }
    // Sequence form of the one-field struct: [] → default, [by_host] → that map, longer → error.
    if (Array.isArray(v)) {
      if (v.length > 1) return new SubscriptionCache();
      v = v.length ? { by_host: v[0] } : {};
    }
    if (!isObj(v)) return new SubscriptionCache();
    const m = new Map();
    if (v.by_host !== undefined) {
      if (!isObj(v.by_host)) return new SubscriptionCache();
      for (const [h, e] of Object.entries(v.by_host)) { const d = decodeEntry(e); if (!d) return new SubscriptionCache(); m.set(h, d); }
    }
    return new SubscriptionCache(m);
  }

  save() {
    const p = SubscriptionCache.cachePath();
    ensureDir();
    const byHost = {};
    for (const [h, e] of this.byHost) byHost[h] = subscriptionCacheEntry(e);
    const tmp = p.replace(/\.json$/, '.json.tmp');
    try { writeFileSync(tmp, stringify(struct({ by_host: struct(byHost) }), true)); } catch (e) { throw context('write subscription cache tmp', new Error(ioErrorText(e))); }
    try { renameSync(tmp, p); } catch (e) { throw context('rename subscription cache', new Error(ioErrorText(e))); }
  }

  static delete() {
    const p = SubscriptionCache.cachePath();
    if (existsSync(p)) { try { rmSync(p); } catch (e) { throw context('failed to delete subscriptions.json', new Error(ioErrorText(e))); } }
  }

  put(entry) { this.byHost.set(entry.resourceHost, { ...entry }); }
  get(host) { return this.byHost.get(asciiLower(host)) ?? null; }
  resolve(url) { const e = this.byHost.get(hostOf(url)); return e && e.state === 'active' ? e : null; }
  markCanceled(subId) { for (const e of this.byHost.values()) if (e.subId === subId) e.state = 'canceled'; }
  markChanged(oldSubId, newEntry) {
    for (const e of this.byHost.values()) if (e.subId === oldSubId) { e.state = 'changed'; e.changedToSubId = newEntry.subId; }
    this.put(newEntry);
  }

  // Full reconcile from `GET /buyers/{buyer}/subscriptions` (one change hop followed).
  reconcileFrom(items) {
    const bySubId = new Map(items.map((i) => [i.subId, i]));
    for (const entry of this.byHost.values()) {
      const item = bySubId.get(entry.subId);
      if (!item) continue;
      entry.state = stateLabel(item.state);
      entry.planTier = item.planTier;
      entry.maxPeriods = item.maxPeriods;
      entry.changedToSubId = item.changedToSubId ?? null;
      entry.planId = item.planId;
      if (item.state === 4 && item.changedToSubId != null) {
        const n = bySubId.get(item.changedToSubId);
        if (n) {
          entry.subId = n.subId; entry.state = stateLabel(n.state); entry.planTier = n.planTier;
          entry.maxPeriods = n.maxPeriods; entry.planId = n.planId; entry.changedToSubId = n.changedToSubId ?? null;
        }
      }
    }
  }
}
