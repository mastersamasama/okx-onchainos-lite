// Automatic-execution authorization grants — upstream autotrade/grants.rs.
// One file per job at `<home>/autotrade/grants/<jobId>.json` (pretty JSON, written whole).
import { join } from 'node:path';
import { stringify, struct } from '../../../../core/json.mjs';
import { Decimal } from './amount.mjs';
import { fromStr, T } from './_serde-json.mjs';
import { onchainosHome, exists, readToString, writeSecure, removeFileQuiet, nowSecs, satAdd, u64Le } from './_fs.mjs';

// upstream: grants.rs::GRANT_VERSION
export const GRANT_VERSION = 1;

// upstream: grants.rs deny reasons
export const DENY_INVALID_JOB_ID = 'invalid job id';
export const DENY_INVALID_VENUE = 'invalid venue';
export const DENY_INVALID_ACTION = 'invalid action';
export const DENY_INVALID_AMOUNT = 'invalid amount';
export const DENY_INVALID_FORMAT = 'invalid format';
export const DENY_NO_GRANT_FILE = 'no grant file';
export const DENY_GRANT_UNREADABLE = 'grant file unreadable';
export const DENY_VERSION_TOO_NEW = 'grant version too new';
export const DENY_JOB_MISMATCH = 'grant job mismatch';
export const DENY_EXPIRED = 'grant expired';
export const DENY_VENUE_NOT_AUTHORIZED = 'venue not authorized';
export const DENY_NO_CAP = 'no cap for action';
export const DENY_OVER_CAP = 'per-trade cap exceeded';

const VENUES = ['dex', 'defi', 'polymarket', 'trade_kit'];
const ACTIONS = ['buy', 'sell'];
// sell allowance mirrored by write_cap_grant (1e18)
const CONSENT_SELL_UNLIMITED = '1000000000000000000';

// upstream: grants.rs::GrantDeny — `.reason` is the stable process-level message.
export class GrantDeny extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
  // upstream: GrantDeny::code
  code() {
    return ({
      [DENY_INVALID_JOB_ID]: 'grant_invalid_job_id', [DENY_INVALID_VENUE]: 'grant_invalid_venue', [DENY_INVALID_ACTION]: 'grant_invalid_action',
      [DENY_INVALID_AMOUNT]: 'grant_invalid_amount', [DENY_INVALID_FORMAT]: 'grant_invalid_format', [DENY_NO_GRANT_FILE]: 'no_grant_file',
      [DENY_GRANT_UNREADABLE]: 'grant_unreadable', [DENY_VERSION_TOO_NEW]: 'grant_version_too_new', [DENY_JOB_MISMATCH]: 'grant_job_mismatch',
      [DENY_EXPIRED]: 'grant_expired', [DENY_VENUE_NOT_AUTHORIZED]: 'venue_not_authorized', [DENY_NO_CAP]: 'no_cap', [DENY_OVER_CAP]: 'over_cap',
    })[this.reason] ?? 'grant_denied';
  }
}

// upstream: grants.rs::VenueGrant / GrantFile (deny_unknown_fields)
const VENUE_GRANT = T.struct('VenueGrant', [['maxBuy', T.option(T.string)], ['maxSell', T.option(T.string)]], { denyUnknown: true });
export const GRANT_FILE = T.struct('GrantFile', [
  ['version', T.u32], ['jobId', T.string], ['grants', T.map(VENUE_GRANT)], ['createdAt', T.u64], ['expiresAt', T.u64],
], { denyUnknown: true });

const venueGrant = (g) => struct({ maxBuy: g.maxBuy ?? null, maxSell: g.maxSell ?? null });
// GrantFile serialisation (struct order; grants is a BTreeMap → sorted keys)
export function grantFileJson(f) {
  const grants = {};
  for (const k of Object.keys(f.grants)) grants[k] = venueGrant(f.grants[k]);
  return struct({ version: f.version, jobId: f.jobId, grants, createdAt: f.createdAt, expiresAt: f.expiresAt });
}

// upstream: grants.rs::canonical_venue
export function canonicalVenue(venue) {
  if (venue === 'hyperliquid') return 'dex';
  return VENUES.includes(venue) ? venue : undefined;
}

// upstream: grants.rs::job_id_is_safe — non-empty [A-Za-z0-9_-]
export const jobIdIsSafe = (jobId) => typeof jobId === 'string' && /^[A-Za-z0-9_-]+$/.test(jobId);

// upstream: grants.rs::grant_path (caller charset-checked the job id)
function grantPath(jobId) {
  let home;
  try { home = onchainosHome(); } catch { throw new GrantDeny(DENY_GRANT_UNREADABLE); }
  return join(home, 'autotrade', 'grants', `${jobId}.json`);
}

// upstream: grants.rs::check_grant — throws GrantDeny; returns undefined on allow.
export function checkGrant(jobId, venue, action, amount) {
  if (!jobIdIsSafe(jobId)) throw new GrantDeny(DENY_INVALID_JOB_ID);
  const v = canonicalVenue(venue);
  if (v === undefined) throw new GrantDeny(DENY_INVALID_VENUE);
  if (!ACTIONS.includes(action)) throw new GrantDeny(DENY_INVALID_ACTION);
  let amt;
  try { amt = Decimal.parse(amount); } catch { throw new GrantDeny(DENY_INVALID_AMOUNT); }
  if (amt.isZero()) throw new GrantDeny(DENY_INVALID_AMOUNT);
  const path = grantPath(jobId);
  if (!exists(path)) throw new GrantDeny(DENY_NO_GRANT_FILE);
  let grant;
  try { grant = fromStr(readToString(path), GRANT_FILE); } catch { throw new GrantDeny(DENY_GRANT_UNREADABLE); }
  if (grant.version > GRANT_VERSION) throw new GrantDeny(DENY_VERSION_TOO_NEW);
  if (grant.jobId !== jobId) throw new GrantDeny(DENY_JOB_MISMATCH);
  if (u64Le(grant.expiresAt, nowSecs())) throw new GrantDeny(DENY_EXPIRED);
  if (!Object.prototype.hasOwnProperty.call(grant.grants, v)) throw new GrantDeny(DENY_VENUE_NOT_AUTHORIZED);
}

function writeGrantFile(jobId, grants, ttlSec) {
  const createdAt = nowSecs();
  const grant = { version: GRANT_VERSION, jobId, grants, createdAt, expiresAt: satAdd(createdAt, ttlSec) };
  let path;
  try { path = grantPath(jobId); } catch (d) { throw new Error(d.reason); }
  writeSecure(path, stringify(grantFileJson(grant), true));
}

// upstream: grants.rs::write_grant (debug-build `autotrade-grant-write` only)
export function writeGrant(jobId, venue, maxBuy, maxSell, ttlSec) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  const v = canonicalVenue(venue);
  if (v === undefined) throw new Error('invalid venue (must be dex|hyperliquid|defi|polymarket|trade_kit)');
  if (BigInt(ttlSec) === 0n) throw new Error('--ttl-sec must be > 0');
  if ((maxBuy === undefined || maxBuy === null) && (maxSell === undefined || maxSell === null)) throw new Error('at least one of --max-buy / --max-sell is required');
  if (maxBuy !== undefined && maxBuy !== null) { try { Decimal.parse(maxBuy); } catch { throw new Error('--max-buy is not a valid decimal'); } }
  if (maxSell !== undefined && maxSell !== null) { try { Decimal.parse(maxSell); } catch { throw new Error('--max-sell is not a valid decimal'); } }
  writeGrantFile(jobId, { [v]: { maxBuy: maxBuy ?? null, maxSell: maxSell ?? null } }, ttlSec);
}

// upstream: grants.rs::write_cap_grant
export function writeCapGrant(jobId, capU, ttlSec) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  if (BigInt(ttlSec) === 0n) throw new Error('ttl must be > 0');
  try { Decimal.parse(capU); } catch { throw new Error('cap is not a valid decimal'); }
  const grants = {};
  for (const venue of VENUES) grants[venue] = { maxBuy: capU, maxSell: venue === 'trade_kit' ? capU : CONSENT_SELL_UNLIMITED };
  writeGrantFile(jobId, grants, ttlSec);
}

// upstream: grants.rs::write_auto_grant
export function writeAutoGrant(jobId, ttlSec) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  if (BigInt(ttlSec) === 0n) throw new Error('ttl must be > 0');
  const grants = {};
  for (const venue of VENUES) grants[venue] = { maxBuy: null, maxSell: null };
  writeGrantFile(jobId, grants, ttlSec);
}

// upstream: grants.rs::clear_grant
export function clearGrant(jobId) {
  let path;
  try { path = grantPath(jobId); } catch { return; }
  removeFileQuiet(path);
}
