// audit.jsonl — upstream audit.rs. Never throws.
import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homePath, ensureDir } from './home.mjs';
import { stringify, struct } from './json.mjs';
import { UPSTREAM_VERSION } from '../config.mjs';

const OS = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || process.platform;
const ARCH = { x64: 'x86_64', arm64: 'aarch64', ia32: 'x86', arm: 'arm' }[process.arch] || process.arch;
export const osArch = () => ({ os: OS, arch: ARCH });

// "%Y-%m-%d {offset:+.1} %H:%M:%S%.3f" in local time
export function auditTs(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset() / 60;
  const offStr = (off >= 0 ? '+' : '-') + Math.abs(off).toFixed(1);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${offStr} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const FULL = new Set(['--otp', '--signed-tx', '--unsigned-tx', '--sui-tx-bytes', '--jito-unsigned-tx', '--input-data', '--data', '--message', '--autotrade', '--secret', '--payload', '--param', '--body', '--routing-json', '--routing-base64', '--params-json', '--params-base64', '--prepared-id', '--items', '--template-vars-b64']);
const ADDR = new Set(['--from', '--wallet', '--email', '--address', '--sub-id', '--new-sub-id', '--job-id', '--tx-hash']);
const POSITIONAL = [['wallet', 'verify'], ['transfer', 'open']];

export function maskAddr(v) {
  const chars = [...v];
  if (chars.length <= 10) return '[REDACTED]';
  return chars.slice(0, 6).join('') + '***' + chars.slice(-4).join('');
}

export function redactArgs(raw) {
  const out = [...raw];
  // positional secrets, e.g. `wallet verify <otp>`
  const plain = raw.map((a, i) => [a.toLowerCase(), i]).filter(([a]) => !a.startsWith('-'));
  for (const pat of POSITIONAL) {
    for (let w = 0; w + pat.length <= plain.length; w++) {
      if (pat.every((p, k) => plain[w + k][0] === p)) {
        const idx = plain[w + pat.length - 1][1] + 1;
        if (idx < raw.length && !raw[idx].startsWith('-')) out[idx] = '[REDACTED]';
        break;
      }
    }
  }
  for (let i = 0; i < out.length; i++) {
    const a = raw[i];
    const eq = a.indexOf('=');
    if (eq > 0) {
      const flag = a.slice(0, eq).toLowerCase();
      if (FULL.has(flag)) out[i] = `${a.slice(0, eq)}=[REDACTED]`;
      else if (ADDR.has(flag)) out[i] = `${a.slice(0, eq)}=${maskAddr(a.slice(eq + 1))}`;
      continue;
    }
    const flag = a.toLowerCase();
    if ((FULL.has(flag) || ADDR.has(flag)) && i + 1 < raw.length) {
      out[i + 1] = FULL.has(flag) ? '[REDACTED]' : maskAddr(raw[i + 1]);
      i++;
    }
  }
  return out;
}

// cli_command_name(): default audit label "<top> <sub>". Handlers whose upstream
// label differs (payment, agent dispute/common, …) declare `label` in their definition.
export function commandLabel(path) {
  const parts = path.split(' ');
  if (['mcp', 'upgrade', 'preflight', 'cross-chain'].includes(parts[0])) return parts[0];
  return parts.slice(0, 2).join(' ');
}

export function auditLog(source, label, ok, elapsedMs, args, error) {
  try {
    ensureDir();
    const file = homePath('audit.jsonl');
    rotateIfNeeded(file);
    const needsHeader = !existsSync(file) || statSync(file).size === 0;
    let text = '';
    if (needsHeader) text += stringify(struct({ type: 'device', os: OS, arch: ARCH, version: UPSTREAM_VERSION })) + '\n';
    let err = error;
    if (err !== undefined && Buffer.byteLength(err) > 512) {
      let cut = err;
      while (Buffer.byteLength(cut) > 512) cut = [...cut].slice(0, -1).join('');
      err = cut + '…';
    }
    text += stringify(struct({ ts: auditTs(), source, command: label, ok, duration_ms: Math.floor(elapsedMs), args, error: err })) + '\n';
    appendFileSync(file, text, { mode: 0o600 });
  } catch {}
}

function rotateIfNeeded(file) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length);
  if (lines.length <= 10000) return;
  const header = lines[0].startsWith('{"type":"device"') ? [lines[0]] : [];
  const rest = (header.length ? lines.slice(1) : lines).slice(-5000);
  writeFileSync(file, [...header, ...rest].map((l) => l + '\n').join(''));
}
