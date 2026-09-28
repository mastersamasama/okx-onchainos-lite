// x402 market-API charging state, payment_cache.json and notifications —
// upstream client.rs §6 (PaymentState), payment_cache.rs, payment_notify.rs.
import { load, save } from './store.mjs';
import { struct } from './json.mjs';
import { pushEvent } from './notify.mjs';
import { cachedChains } from './chains.mjs';

export const BASIC_FREE_QUOTA = 1000000;
export const PREMIUM_FREE_QUOTA = 100000;
export const DOC_URL = 'https://web3.okx.com/onchainos/dev-docs/market/market-api-fee';
const INTRO_START = Date.parse('2026-04-30T00:00:00Z');
const GRACE_EXPIRES = Date.parse('2026-05-30T00:00:00Z');
const GRACE_EXPIRES_STR = '2026-05-30T00:00:00+00:00';
const GRACE_DAYS = 30;

const nowSecs = () => Math.floor(Date.now() / 1000);
const tierFromServer = (s) => (typeof s === 'string' && ['basic', 'premium'].includes(s.toLowerCase()) ? s.toLowerCase() : undefined);

export class PaymentState {
  constructor() {
    this.endpoints = new Map();
    this.accepts = null;
    this.basic = 'free';
    this.premium = 'free';
    this.configLoaded = false;
    this.userType = null;       // 'new' | 'old' | null
    this.introShown = false;
    this.graceShown = false;
    this.pendingOverQuota = new Set();
    this.defaultAsset = null;   // {asset, network, name?}
    this.localSigningWarned = false;
  }

  anyCharging() { return this.basic !== 'free' || this.premium !== 'free'; }
  tierState(t) { return t === 'premium' ? this.premium : this.basic; }

  // ok-web3-openapi-pay: Basic=1;Premium=0;UserType=1
  applyHeader(value) {
    if (value == null) return;
    const seen = {};
    for (const part of String(value).split(';')) {
      const p = part.trim();
      const eq = p.indexOf('=');
      if (eq < 0) continue;
      const k = p.slice(0, eq).trim().toLowerCase(), v = p.slice(eq + 1).trim();
      if (k in seen) continue;
      seen[k] = v;
    }
    const before = [this.basic, this.premium, this.userType].join();
    const flag = (v) => (v === '1' ? true : v === '0' ? false : undefined);
    const apply = (cur, f) => (f === undefined ? cur : f === false ? 'free' : cur === 'free' ? 'charging_unconfirmed' : cur);
    this.basic = apply(this.basic, flag(seen.basic));
    this.premium = apply(this.premium, flag(seen.premium));
    if (seen.usertype === '1') this.userType = 'new';
    else if (seen.usertype === '0') this.userType = 'old';
    if (before !== [this.basic, this.premium, this.userType].join()) this.flush();
  }

  restoreFromCache() {
    let c;
    try { c = load('payment_cache.json'); } catch { c = null; }
    if (!c) return false;
    this.basic = c.basic_state ?? 'free';
    this.premium = c.premium_state ?? 'free';
    this.userType = c.user_type ?? null;
    this.introShown = !!c.intro_shown;
    this.graceShown = !!c.grace_shown;
    this.defaultAsset = c.default_asset ?? null;
    this.localSigningWarned = !!c.local_signing_warned;
    const fresh = nowSecs() - Number(c.updated_at ?? 0) <= 3600;
    const eps = c.endpoints && typeof c.endpoints === 'object' ? Object.entries(c.endpoints) : [];
    const acc = c.accepts;
    if (!fresh || !eps.length || acc == null || (Array.isArray(acc) && !acc.length)) return false;
    this.endpoints = new Map(eps.map(([p, t]) => [p, tierFromServer(t)]).filter(([, t]) => t));
    this.accepts = acc;
    this.configLoaded = true;
    return true;
  }

  applyConfig(data) {
    this.endpoints.clear();
    const list = data?.endpointList;
    if (list && typeof list === 'object') {
      for (const [p, t] of Object.entries(list)) { const tier = tierFromServer(t); if (tier) this.endpoints.set(p, tier); }
    }
    if (data && data.accepts != null) this.accepts = data.accepts;
    this.flush();
  }

  flush() {
    try {
      let disk = null;
      try { disk = load('payment_cache.json'); } catch {}
      if (disk) {
        if ('default_asset' in disk) this.defaultAsset = disk.default_asset ?? null;
        if ('local_signing_warned' in disk) this.localSigningWarned = !!disk.local_signing_warned;
      }
      save('payment_cache.json', struct({
        endpoints: Object.fromEntries(this.endpoints),
        accepts: this.accepts,
        basic_state: this.basic,
        premium_state: this.premium,
        updated_at: nowSecs(),
        user_type: this.userType,
        intro_shown: this.introShown,
        grace_shown: this.graceShown,
        default_asset: this.defaultAsset ? struct({ asset: this.defaultAsset.asset, network: this.defaultAsset.network, name: this.defaultAsset.name ?? undefined }) : null,
        local_signing_warned: this.localSigningWarned,
      }), { pretty: false });
    } catch {}
  }

  // Returns true when the caller must stop with an empty Confirming (exit 2).
  consumePendingConfirmation(path) {
    const tier = this.endpoints.get(path);
    if (tier) return this.pendingOverQuota.delete(tier);
    if (this.pendingOverQuota.size) { this.pendingOverQuota.clear(); return true; }
    return false;
  }

  dispatchNotifications(path, headerAccepts) {
    if (!this.userType) return;
    const events = computeEvents({
      userType: this.userType, now: Date.now(), basic: this.basic, premium: this.premium,
      introShown: this.introShown, graceShown: this.graceShown,
      accepts: headerAccepts ?? this.accepts, pathTier: this.endpoints.get(path), preferred: this.defaultAsset,
    });
    for (const [event, flag] of events) {
      pushEvent(event);
      if (flag === 'grace') this.graceShown = true;
      else if (flag === 'intro') this.introShown = true;
      else if (flag === 'basic' || flag === 'premium') this.pendingOverQuota.add(flag);
    }
    if (events.length) this.flush();
  }
}

export function amountMinimalToDisplay(s, decimals = 6) {
  const d = String(s).replace(/^0+(?=\d)/, '');
  const padded = d.padStart(decimals + 1, '0');
  const int = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '');
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function networkShowName(network) {
  if (network == null) return '';
  const hit = cachedChains().find((c) => c && String(c.realChainIndex) === String(network));
  return hit?.showName ?? String(network);
}

function transformPaymentEntry(entry, tier, preferred) {
  if (!entry || typeof entry !== 'object') return null;
  let amount = entry.amount;
  if (amount && typeof amount === 'object') amount = amount[tier];
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null;
  const m = typeof entry.network === 'string' && entry.network.match(/^eip155:(\d+)$/);
  return {
    amount: amountMinimalToDisplay(amount),
    asset: entry.asset ?? null,
    chainId: m ? Number(m[1]) : null,
    isDefault: !!(preferred && entry.asset === preferred.asset && entry.network === preferred.network),
    name: entry.extra?.name ?? '',
    network: networkShowName(entry.network),
    payTo: entry.payTo ?? null,
    symbol: entry.extra?.symbol ?? '',
  };
}

export function computeEvents({ userType, now, basic, premium, introShown, graceShown, accepts, pathTier, preferred }) {
  const out = [];
  if (!userType) return out;
  const inGrace = userType === 'old' && basic === 'free' && premium === 'free' && now < GRACE_EXPIRES;
  if (inGrace) {
    if (!graceShown) out.push([{ code: 'MARKET_API_OLD_USER_GRACE', data: { basicFreeQuota: BASIC_FREE_QUOTA, docUrl: DOC_URL, graceDays: GRACE_DAYS, graceExpiresAt: GRACE_EXPIRES_STR, premiumFreeQuota: PREMIUM_FREE_QUOTA } }, 'grace']);
    return out;
  }
  if (!introShown) {
    if (userType === 'new' && now < INTRO_START) { /* nothing */ }
    else if (userType === 'new') out.push([{ code: 'MARKET_API_NEW_USER_INTRO', data: { basicFreeQuota: BASIC_FREE_QUOTA, docUrl: DOC_URL, premiumFreeQuota: PREMIUM_FREE_QUOTA } }, 'intro']);
    else out.push([{ code: 'MARKET_API_OLD_USER_POST_GRACE_INTRO', data: { basicFreeQuota: BASIC_FREE_QUOTA, docUrl: DOC_URL, graceDays: GRACE_DAYS, premiumFreeQuota: PREMIUM_FREE_QUOTA } }, 'intro']);
  }
  const code = userType === 'new' ? 'MARKET_API_NEW_USER_OVER_QUOTA' : 'MARKET_API_OLD_USER_POST_GRACE_OVER_QUOTA';
  for (const tier of ['basic', 'premium']) {
    const state = tier === 'basic' ? basic : premium;
    if (state === 'charging_unconfirmed' && (!pathTier || pathTier === tier)) {
      const payment = (Array.isArray(accepts) ? accepts : []).map((e) => transformPaymentEntry(e, tier, preferred)).filter(Boolean);
      out.push([{ code, data: { payment: payment.length ? payment : undefined, tier } }, tier]);
    }
  }
  return out;
}
