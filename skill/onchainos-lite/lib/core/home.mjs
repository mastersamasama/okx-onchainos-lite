// State directory helpers. Layout and permissions follow upstream home.rs / file_keyring.rs.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { HOME_DIR } from '../config.mjs';

export const home = () => HOME_DIR;
export const homePath = (...parts) => join(HOME_DIR, ...parts);

export function ensureDir(dir = HOME_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') try { chmodSync(dir, 0o700); } catch {}
  return dir;
}

// Atomic write (tmp + rename) with 0600, as upstream does for secrets and state.
export function writeAtomic(path, data, { mode = 0o600, tmpExt = '.tmp' } = {}) {
  ensureDir(dirname(path));
  const tmp = path + tmpExt;
  writeFileSync(tmp, data, { mode });
  if (process.platform !== 'win32') try { chmodSync(tmp, mode); } catch {}
  renameSync(tmp, path);
}

export function readJson(path, fallback = undefined) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export const writeJson = (path, value, opts) => writeAtomic(path, JSON.stringify(value, null, 2), opts);
export const exists = (path) => existsSync(path);
export const remove = (path) => rmSync(path, { force: true, recursive: true });
