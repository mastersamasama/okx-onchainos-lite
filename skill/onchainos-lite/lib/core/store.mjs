// JSON state files under the state dir — upstream wallet_store.rs formats:
// serde_json::to_string_pretty (no trailing newline), written to "<name>.tmp" then renamed.
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { homePath, ensureDir } from './home.mjs';
import { parse, stringify, struct } from './json.mjs';

export function load(name) {
  const p = homePath(name);
  if (!existsSync(p)) return null;
  let text;
  try { text = readFileSync(p, 'utf8'); } catch { throw new Error(`failed to read ${name}`); }
  try { return parse(text); } catch (e) { throw new Error(`failed to parse ${name}: ${e.message}`); }
}

export function save(name, value, { pretty = true } = {}) {
  ensureDir();
  const p = homePath(name);
  writeFileSync(p + '.tmp', stringify(value, pretty));
  renameSync(p + '.tmp', p);
}

export function remove(name) {
  const p = homePath(name);
  if (existsSync(p)) rmSync(p, { force: true });
}

// session.json — SessionJson (camelCase, all default "")
export const SESSION_FIELDS = ['saTeeId', 'sessionCert', 'encryptedSessionSk', 'sessionKeyExpireAt', 'deviceId'];
export function sessionStruct(s = {}) {
  return struct(Object.fromEntries(SESSION_FIELDS.map((k) => [k, s[k] == null ? '' : String(s[k])])));
}
export const loadSession = () => { const s = load('session.json'); return s ? sessionStruct(s) : null; };
export const saveSession = (s) => save('session.json', sessionStruct(s));
export const deleteSession = () => remove('session.json');

// chain_cache.json — { updated_at, chains: [...] }
export function loadChainCache() {
  const c = load('chain_cache.json');
  return c ? { updated_at: Number(c.updated_at ?? 0), chains: Array.isArray(c.chains) ? c.chains : [] } : null;
}
export const saveChainCache = (chains) => save('chain_cache.json', struct({ updated_at: Math.floor(Date.now() / 1000), chains }));
