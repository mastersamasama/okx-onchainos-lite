// `ocl auth …` (lite-only): API-key auth and sealed credential transfer.
// Secrets never appear on stdout, in argv, or in the audit log:
//   api-key set reads env or stdin; transfer moves an HPKE-sealed blob that only the
//   target's one-time key can open (the agent relaying it only ever sees ciphertext).
import { readFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { struct } from '../../core/json.mjs';
import * as keyring from '../../core/keyring.mjs';
import { load, save, loadSession, saveSession } from '../../core/store.mjs';
import { resolveApiKey, AK_KEYS, maskKey } from '../../core/apikey.mjs';
import { isJwtExpired } from '../../core/http.mjs';
import { x25519 } from '../../crypto/curve25519.mjs';
import { seal, open } from '../../crypto/hpke.mjs';
import { EMPTY } from '../../core/context.mjs';

const INFO = Buffer.from('onchainos-lite-transfer-v1');
const RCPT = 'ocl-rcpt-v1.';
const SEALED = 'ocl-seal-v1.';
const TTL_MS = 30 * 60 * 1000;
const b64u = (b) => Buffer.from(b).toString('base64url');

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function parseCredText(text) {
  const t = text.trim();
  if (!t) return {};
  if (t.startsWith('{')) return JSON.parse(t);
  const out = {};
  for (const line of t.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim().replace(/^export\s+/, '')] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function storeApiKey(v) {
  const apiKey = v.OKX_API_KEY || v.OKX_ACCESS_KEY || v.apiKey;
  const secretKey = v.OKX_SECRET_KEY || v.secretKey;
  const passphrase = v.OKX_PASSPHRASE || v.passphrase;
  const projectId = v.OKX_PROJECT_ID || v.projectId || '';
  if (!apiKey || !secretKey || !passphrase) throw new Error('API key, secret key and passphrase are all required (OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE)');
  keyring.store([[AK_KEYS.apiKey, apiKey], [AK_KEYS.secretKey, secretKey], [AK_KEYS.passphrase, passphrase], [AK_KEYS.projectId, projectId]]);
  return { apiKey, projectId };
}

function status() {
  let blob = {};
  try { blob = keyring.readBlob(); } catch {}
  const access = blob.access_token, refresh = blob.refresh_token;
  let ak = null, akError = null;
  try { ak = resolveApiKey(); } catch (e) { akError = e.message; }
  const walletJwt = !!access && !isJwtExpired(access);
  const refreshable = !!refresh && !isJwtExpired(refresh);
  let wallets = null;
  try { wallets = load('wallets.json'); } catch {}
  return struct({
    mode: walletJwt || refreshable ? 'wallet-jwt' : ak ? 'api-key' : 'anonymous',
    wallet: struct({ loggedIn: walletJwt || refreshable, accessTokenValid: walletJwt, refreshTokenValid: refreshable, email: wallets?.email ? String(wallets.email).replace(/^(.{2}).*(@.*)$/, '$1***$2') : null }),
    apiKey: struct({ configured: !!ak, source: ak?.source ?? null, key: ak ? maskKey(ak.apiKey) : null, projectId: ak?.projectId ? maskKey(ak.projectId) : null, error: akError ?? undefined }),
    note: 'Wallet commands need the wallet login (ocl wallet login). Market/token/swap-quote/portfolio/DeFi-data commands use the API key when no wallet login is active.',
  });
}

export default {
  'auth status': { uses: [], label: 'auth status', run: async () => status() },

  'auth api-key set': {
    uses: ['fromEnv', 'stdin'],
    label: 'auth api-key set',
    async run(ctx, o) {
      if (o.fromEnv === o.stdin) throw new Error('choose exactly one source: --from-env or --stdin');
      const v = o.fromEnv ? process.env : parseCredText(readStdin());
      const r = storeApiKey(v);
      return struct({ stored: true, key: maskKey(r.apiKey), projectId: r.projectId ? maskKey(r.projectId) : null, source: 'keyring' });
    },
  },

  'auth api-key clear': {
    uses: [],
    label: 'auth api-key clear',
    async run() {
      keyring.update((blob) => { for (const k of Object.values(AK_KEYS)) delete blob[k]; }, { tolerateCorrupt: true });
      return EMPTY;
    },
  },

  'auth transfer init': {
    uses: [],
    label: 'auth transfer init',
    async run() {
      const { secret, publicKey } = x25519.generate();
      keyring.store([['transfer_recipient_sk', secret.toString('base64')], ['transfer_recipient_created', String(Date.now())]]);
      const code = RCPT + b64u(publicKey);
      return struct({
        recipient: code,
        expiresInMinutes: TTL_MS / 60000,
        next: `On the machine that holds the credentials run: ocl auth transfer seal --to ${code}   (add --session to also move the wallet login). Then run here: ocl auth transfer open <sealed blob>`,
      });
    },
  },

  'auth transfer seal': {
    uses: ['to', 'session', 'noApiKey'],
    label: 'auth transfer seal',
    async run(ctx, o) {
      if (!o.to.startsWith(RCPT)) throw new Error(`--to must be a recipient code starting with ${RCPT}`);
      const pk = Buffer.from(o.to.slice(RCPT.length), 'base64url');
      if (pk.length !== 32) throw new Error('invalid recipient code');
      const payload = { v: 1, created: Date.now() };
      if (!o.noApiKey) {
        const ak = resolveApiKey();
        if (ak) payload.apiKey = { apiKey: ak.apiKey, secretKey: ak.secretKey, passphrase: ak.passphrase, projectId: ak.projectId || '' };
      }
      if (o.session) {
        const blob = keyring.readBlob();
        if (!blob.access_token || !blob.refresh_token || !blob.session_key) throw new Error('no wallet login to transfer — run `ocl wallet login` on this machine first');
        const session = loadSession();
        payload.session = { keyring: { access_token: blob.access_token, refresh_token: blob.refresh_token, session_key: blob.session_key }, session, wallets: load('wallets.json') };
      }
      if (!payload.apiKey && !payload.session) throw new Error('nothing to transfer: no API key configured (set OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE or run `ocl auth api-key set`) and --session not given');
      // deflated: wallets.json repeats each address per chain, so a session blob shrinks ~8x
      const { enc, ciphertext } = seal({ pkR: pk, plaintext: deflateRawSync(Buffer.from(JSON.stringify(payload)), { level: 9 }), info: INFO });
      return struct({
        sealed: SEALED + b64u(Buffer.concat([enc, ciphertext])),
        contains: [payload.apiKey && 'api-key', payload.session && 'wallet-session'].filter(Boolean),
        next: 'Paste the sealed value to the target and run: ocl auth transfer open <sealed>. It can only be opened by the target that ran `auth transfer init`.',
      });
    },
  },

  'auth transfer open': {
    uses: ['sealed'],
    label: 'auth transfer open',
    async run(ctx, o) {
      const blob = keyring.readBlob();
      const sk = blob.transfer_recipient_sk;
      if (!sk) throw new Error('no pending transfer on this machine — run `ocl auth transfer init` first');
      if (Date.now() - Number(blob.transfer_recipient_created || 0) > TTL_MS) throw new Error('the recipient code expired — run `ocl auth transfer init` again');
      // `-` reads the blob from stdin (long session blobs, or keeping it out of the shell history)
      const s = (o.sealed === '-' ? readStdin() : String(o.sealed)).trim();
      if (!s.startsWith(SEALED)) throw new Error(`sealed value must start with ${SEALED}`);
      const raw = Buffer.from(s.slice(SEALED.length), 'base64url');
      let payload;
      try { payload = JSON.parse(inflateRawSync(open({ skR: Buffer.from(sk, 'base64'), enc: raw.subarray(0, 32), ciphertext: raw.subarray(32), info: INFO })).toString('utf8')); }
      catch { throw new Error('could not open the sealed value (wrong recipient or corrupted input)'); }
      const imported = [];
      if (payload.apiKey) { storeApiKey(payload.apiKey); imported.push('api-key'); }
      if (payload.session) {
        const k = payload.session.keyring;
        keyring.store([['access_token', k.access_token], ['refresh_token', k.refresh_token], ['session_key', k.session_key]]);
        const local = loadSession();
        saveSession({ ...(payload.session.session || {}), deviceId: local?.deviceId || payload.session.session?.deviceId || '' });
        if (payload.session.wallets) save('wallets.json', payload.session.wallets);
        imported.push('wallet-session');
      }
      keyring.update((after) => { delete after.transfer_recipient_sk; delete after.transfer_recipient_created; });
      return struct({ imported, status: status() });
    },
  },
};
