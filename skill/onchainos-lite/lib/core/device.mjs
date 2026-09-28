// device-id / device-name request headers (upstream device/id.rs, device/name.rs).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadSession, saveSession } from './store.mjs';

const valid = (id) => typeof id === 'string' && (id.length === 64 || id.length === 36) && /^[A-Za-z0-9-]+$/.test(id);

// machine-uid 0.3.0 sources
function machineId() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true });
      const m = r.stdout && r.stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m) return m[1].trim();
      return null;
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const m = r.stdout && r.stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return m ? m[1].trim() : null;
    }
    for (const p of ['/var/lib/dbus/machine-id', '/etc/machine-id']) {
      try { const v = readFileSync(p, 'utf8').trim(); if (v) return v; } catch {}
    }
    if (/bsd/.test(process.platform)) { try { return readFileSync('/etc/hostid', 'utf8').trim(); } catch {} }
  } catch {}
  return null;
}

let cachedId;
export function deviceId() {
  if (cachedId !== undefined) return cachedId;
  let session = null;
  try { session = loadSession(); } catch {}
  if (session && valid(session.deviceId)) return (cachedId = session.deviceId);
  const mid = machineId();
  const id = mid ? createHash('sha256').update(Buffer.concat([Buffer.from(mid, 'utf8'), Buffer.from('onchainos')])).digest('hex') : randomUUID();
  try { saveSession({ ...(session || {}), deviceId: id }); } catch {}
  return (cachedId = id);
}

function rawDeviceName() {
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.replace(/\n$/, '');
    } else if (process.platform === 'linux') {
      try {
        const info = readFileSync('/etc/machine-info', 'utf8');
        const m = info.match(/^PRETTY_HOSTNAME=(.*)$/m);
        if (m) {
          let v = m[1].trim().replace(/^["']|["']$/g, '');
          v = v.replace(/\\(.)/g, (_, c) => ({ t: '\t', r: '\r', n: '\n' }[c] ?? c));
          if (v) return v;
        }
      } catch {}
    }
    return hostname() || 'LocalHost';
  } catch {
    return 'LocalHost';
  }
}

// normalize_device_name: trim, drop Unicode Cc, empty → unknown-device, ≤128 bytes on a char boundary
export function normalizeDeviceName(s) {
  let v = String(s).trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  if (!v) return 'unknown-device';
  while (Buffer.byteLength(v) > 128) v = [...v].slice(0, -1).join('');
  return v;
}

let cachedName;
export const deviceName = () => (cachedName ??= normalizeDeviceName(rawDeviceName()));
