// Encrypted file credential store — byte-compatible with upstream file_keyring.rs.
//   keyring.enc = salt(32) || nonce(12) || AES-256-GCM(json map)
//   key = scrypt(identity, salt, N=2^15, r=8, p=1, 32)
//   identity = contents of `machine-identity` (random 32-byte hex, created once)
// Lite always uses the file store (no OS keychain), which is what upstream does on
// Linux and what works inside sandboxes such as the Muse VM.
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, openSync, closeSync, statSync, rmSync } from 'node:fs';
import { userInfo, hostname } from 'node:os';
import { homePath, writeAtomic, ensureDir, exists, remove } from './home.mjs';

const SALT_LEN = 32, NONCE_LEN = 12;
const deriveKey = (identity, salt) => scryptSync(identity, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

export function encryptBlob(map, identity) {
  const salt = randomBytes(SALT_LEN), nonce = randomBytes(NONCE_LEN);
  const c = createCipheriv('aes-256-gcm', deriveKey(identity, salt), nonce);
  return Buffer.concat([salt, nonce, c.update(JSON.stringify(map)), c.final(), c.getAuthTag()]);
}

export function decryptBlob(data, identity) {
  if (data.length < SALT_LEN + NONCE_LEN + 1) throw new Error('keyring.enc is corrupted (too short)');
  const salt = data.subarray(0, SALT_LEN), nonce = data.subarray(SALT_LEN, SALT_LEN + NONCE_LEN);
  const body = data.subarray(SALT_LEN + NONCE_LEN);
  const d = createDecipheriv('aes-256-gcm', deriveKey(identity, salt), nonce);
  d.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function readSystemMachineId() {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id', '/proc/sys/kernel/hostname']) {
    try { const v = readFileSync(p, 'utf8').trim(); if (v) return v; } catch {}
  }
  return hostname() || 'unknown-host';
}
const volatileIdentity = () =>
  `${readSystemMachineId()}:${process.env.USER || process.env.LOGNAME || safeUser() || 'onchainos-user'}`;
function safeUser() { try { return userInfo().username; } catch { return undefined; } }

export function machineIdentity() {
  const path = homePath('machine-identity');
  try { const v = readFileSync(path, 'utf8').trim(); if (v) return v; } catch {}
  try {
    ensureDir();
    writeAtomic(path, randomBytes(32).toString('hex'));
    return readFileSync(path, 'utf8').trim();
  } catch {
    return volatileIdentity();
  }
}

const KEYRING = () => homePath('keyring.enc');

export function readBlob() {
  const path = KEYRING();
  if (!exists(path)) return {};
  const data = readFileSync(path);
  const identity = machineIdentity();
  try { return decryptBlob(data, identity); } catch {}
  const legacy = volatileIdentity();
  if (legacy !== identity) {
    try {
      const map = decryptBlob(data, legacy);
      try { writeBlob(map); } catch (e) { process.stderr.write(`Warning: identity migration re-encrypt failed (${e.message}), will retry next read\n`); }
      return map;
    } catch {}
  }
  throw new Error('Credentials corrupted. Please login again: onchainos wallet login');
}

export function writeBlob(map) {
  ensureDir();
  writeAtomic(KEYRING(), encryptBlob(map, machineIdentity()), { tmpExt: '.tmp' });
}

// Read-modify-write under an exclusive lock file. Agents often run several commands at
// once (the Muse agent does); without the lock two writers lose each other's keys
// (e.g. a pending login next to a pending credential transfer). Stale locks (>15 s) are broken.
function lockedSync(fn) {
  ensureDir();
  const lock = homePath('keyring.lock');
  const deadline = Date.now() + 20000;
  for (;;) {
    try { closeSync(openSync(lock, 'wx', 0o600)); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 15000) { rmSync(lock, { force: true }); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('keyring is locked by another onchainos process');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}

// update(mutator): mutator receives the current map, edits it in place (or returns a new map).
export function update(mutator, { tolerateCorrupt = false } = {}) {
  return lockedSync(() => {
    let m;
    try { m = readBlob(); } catch (e) { if (!tolerateCorrupt) throw e; m = {}; }
    const next = mutator(m) ?? m;
    writeBlob(next);
    return next;
  });
}

// keyring_store.rs API
export const get = (key) => readBlob()[key];
export function getOpt(key) { try { const v = readBlob()[key]; return v === undefined ? undefined : v; } catch { return undefined; } }
export const set = (key, value) => update((m) => { m[key] = value; });
export const del = (key) => update((m) => { delete m[key]; });
export const store = (pairs) => update((m) => { for (const [k, v] of pairs) m[k] = v; }, { tolerateCorrupt: true });
export const clearAll = () => lockedSync(() => remove(KEYRING()));
