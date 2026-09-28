// OKX Web3 API-key (AK) authentication — lite extension.
// Upstream removed AK mode after v3.3.15; lite restores it with the same wire format:
//   OK-ACCESS-KEY / OK-ACCESS-SIGN / OK-ACCESS-PASSPHRASE / OK-ACCESS-TIMESTAMP, ok-client-type: cli
//   sign = base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath(+?query) + body))
//   timestamp = UTC ISO-8601 with milliseconds ("2026-09-28T10:00:00.000Z")
// Precedence (as v3.3.15): valid wallet JWT > API key > anonymous.
// Sources, first hit wins: env OKX_API_KEY|OKX_ACCESS_KEY + OKX_SECRET_KEY + OKX_PASSPHRASE (+ OKX_PROJECT_ID),
// then the encrypted keyring (set by `ocl auth api-key set` / `ocl auth transfer open`),
// then <state dir>/.env (plain dotenv, as upstream v3 read ~/.onchainos/.env).
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homePath } from './home.mjs';
import * as keyring from './keyring.mjs';

export const AK_KEYS = { apiKey: 'okx_api_key', secretKey: 'okx_secret_key', passphrase: 'okx_passphrase', projectId: 'okx_project_id' };

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim().replace(/^export\s+/, '')] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const fromVars = (v, source) => {
  const apiKey = v.OKX_API_KEY || v.OKX_ACCESS_KEY;
  if (!apiKey) return null;
  return { apiKey, secretKey: v.OKX_SECRET_KEY || '', passphrase: v.OKX_PASSPHRASE || '', projectId: v.OKX_PROJECT_ID || '', source };
};

// Returns { apiKey, secretKey, passphrase, projectId, source } or null. Throws like v3 when incomplete.
export function resolveApiKey() {
  let c = fromVars(process.env, 'env');
  if (!c) {
    let blob = {};
    try { blob = keyring.readBlob(); } catch {}
    if (blob[AK_KEYS.apiKey]) c = { apiKey: blob[AK_KEYS.apiKey], secretKey: blob[AK_KEYS.secretKey] || '', passphrase: blob[AK_KEYS.passphrase] || '', projectId: blob[AK_KEYS.projectId] || '', source: 'keyring' };
  }
  if (!c) {
    const p = homePath('.env');
    if (existsSync(p)) { try { c = fromVars(parseDotenv(readFileSync(p, 'utf8')), 'dotenv'); } catch {} }
  }
  if (!c) return null;
  if (!c.secretKey) throw new Error('OKX_SECRET_KEY is required but not set');
  if (!c.passphrase) throw new Error('OKX_PASSPHRASE is required but not set');
  return c;
}

export const akTimestamp = (d = new Date()) => d.toISOString();

export function akSign(secretKey, timestamp, method, requestPath, body = '') {
  return createHmac('sha256', secretKey).update(`${timestamp}${method}${requestPath}${body}`).digest('base64');
}

export function akHeaders(cred, method, requestPath, body = '', timestamp = akTimestamp()) {
  const h = {
    'OK-ACCESS-KEY': cred.apiKey,
    'OK-ACCESS-SIGN': akSign(cred.secretKey, timestamp, method, requestPath, body),
    'OK-ACCESS-PASSPHRASE': cred.passphrase,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'ok-client-type': 'cli',
  };
  if (cred.projectId) h['OK-ACCESS-PROJECT'] = cred.projectId;
  return h;
}

export const maskKey = (k) => (!k ? '' : k.length <= 8 ? '****' : `${k.slice(0, 4)}…${k.slice(-4)}`);
