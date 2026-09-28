// Per-channel MPP session state for the `payment session {open,voucher,topup,close}` decision
// layer — upstream commands/payment/session_state.rs.
//
// $HOME/sessions/{sanitize(channelId)}.json holds the channel deposit + latest authorized
// cumulative (pretty JSON, struct field order) so `voucher` can compute `needsTopUp` and `close`
// the refund without the agent doing arithmetic. No key material, no signed voucher. Reads are
// best-effort: a missing or corrupt file degrades to "no prior state".
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homePath } from '../core/home.mjs';
import { stringify, struct } from '../core/json.mjs';
import { context } from '../core/errors.mjs';
import { fromStr as serdeFromStr, T } from '../wallet/_serde-json.mjs';
import { ioErrorText, isObj, asU64 } from './_rs.mjs';

// upstream: session_state.rs::sessions_dir (private) — created on demand, default permissions.
function sessionsDir() {
  const dir = homePath('sessions');
  try { mkdirSync(dir, { recursive: true }); } catch (e) { throw context('failed to create ~/.onchainos/sessions', new Error(ioErrorText(e))); }
  return dir;
}

// upstream: session_state.rs::sanitize (private) — keep [0-9A-Za-z_-], drop everything else.
export function sanitize(channelId) {
  let out = '';
  for (const c of String(channelId)) if (/^[0-9A-Za-z_-]$/.test(c)) out += c;
  return out;
}

// upstream: session_state.rs::state_path (private) — creates sessions/ as a side effect.
export const statePath = (channelId) => join(sessionsDir(), `${sanitize(channelId)}.json`);

// std Path::with_extension("json.tmp") for "<stem>.json" ("" stem: ".json" has no extension).
const tmpPathOf = (path, stem) => (stem === '' ? `${path}.json.tmp` : `${path}.tmp`);

// upstream: session_state.rs::ChannelState — atomic-integer strings, never a key or signature.
export class ChannelState {
  constructor({ channel_id = '', owner_wallet = '', deposit = '', cumulative = '', created_at = 0, updated_at = 0 } = {}) {
    Object.assign(this, { channel_id, owner_wallet, deposit, cumulative, created_at, updated_at });
  }

  // serde Serialize (declaration order)
  toStruct() {
    return struct({
      channel_id: this.channel_id, owner_wallet: this.owner_wallet, deposit: this.deposit, cumulative: this.cumulative,
      created_at: this.created_at, updated_at: this.updated_at,
    });
  }

  // upstream: session_state.rs::ChannelState::write — to_string_pretty → .json.tmp → rename.
  write() {
    const path = statePath(this.channel_id);
    const tmp = tmpPathOf(path, sanitize(this.channel_id));
    const body = stringify(this.toStruct(), true);
    try { writeFileSync(tmp, body); } catch (e) { throw context(`write ${tmp}`, new Error(ioErrorText(e))); }
    try { renameSync(tmp, path); } catch (e) { throw context(`rename into ${path}`, new Error(ioErrorText(e))); }
  }
}

// ChannelState::write for a plain {channel_id, owner_wallet, deposit, cumulative, created_at, updated_at}.
export const write = (state) => new ChannelState(state).write();

const FIELDS = [['channel_id', 'str'], ['owner_wallet', 'str'], ['deposit', 'str'], ['cumulative', 'str'], ['created_at', 'u64'], ['updated_at', 'u64']];

// serde derive shape of ChannelState for the streaming decoder: struct rules (duplicate field,
// missing field, seq-form length) are enforced while parsing; u64 fields are range-checked after.
const CHANNEL_STATE_T = T.struct('ChannelState', FIELDS.map(([k, kind]) => [k, kind === 'str' ? T.string : T.value]));

// serde_json::from_str::<ChannelState>(text) → ChannelState | null (any serde error → null).
export function channelStateFromStr(bytes) {
  let v;
  try { v = serdeFromStr(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8'), CHANNEL_STATE_T); } catch { return null; }
  return decodeChannelState(v);
}

// ChannelState from an already-parsed JSON value (object or seq form) → ChannelState | null.
export function decodeChannelState(v) {
  const ok = (kind, x) => (kind === 'str' ? typeof x === 'string' : asU64(x) !== undefined);
  const out = {};
  if (Array.isArray(v)) {
    if (v.length !== FIELDS.length) return null;
    for (const [i, [k, kind]] of FIELDS.entries()) { if (!ok(kind, v[i])) return null; out[k] = kind === 'u64' ? asU64(v[i]) : v[i]; }
    return new ChannelState(out);
  }
  if (!isObj(v)) return null;
  for (const [k, kind] of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(v, k) || !ok(kind, v[k])) return null;
    out[k] = kind === 'u64' ? asU64(v[k]) : v[k];
  }
  return new ChannelState(out);
}

// upstream: session_state.rs::read — best-effort; null when missing or unparseable.
export function read(channelId) {
  let path;
  try { path = statePath(channelId); } catch { return null; }
  // fs::read_to_string (UTF-8 required; a BOM is kept and then rejected by serde_json).
  let bytes;
  try { bytes = readFileSync(path); new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  return channelStateFromStr(bytes);
}

// upstream: session_state.rs::cleanup — best-effort delete (on channel close).
export function cleanup(channelId) {
  let path;
  try { path = statePath(channelId); } catch { return; }
  try { rmSync(path); } catch {}
}

// upstream: session_state.rs::now_unix — current Unix seconds (never negative).
export const nowUnix = () => Math.max(0, Math.floor(Date.now() / 1000));
