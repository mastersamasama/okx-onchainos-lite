// Process helpers: self-invocation (upstream spawns its own `onchainos` binary),
// opening a browser (upstream open::that_detached), sleeping.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'ocl.mjs');

// Run `onchainos <args>` in-process-equivalent: a child of this runtime.
export function runSelf(args, { timeoutMs = 30000, env, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ENTRY, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [], err = [];
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, stdout: '', stderr: 'spawn failed' }); });
    if (input) p.stdin.write(input);
    p.stdin.end();
  });
}

// Detached background child (daemons such as `ws run-daemon`, watch).
// stdoutFd / stderrFd default to logFd (upstream `ws start`: stdout=null, stderr=daemon.log).
export function spawnSelfDetached(args, { env, logFd, stdoutFd, stderrFd } = {}) {
  const out = stdoutFd !== undefined ? stdoutFd : logFd ?? 'ignore';
  const err = stderrFd !== undefined ? stderrFd : logFd ?? 'ignore';
  const p = spawn(process.execPath, [ENTRY, ...args], { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', out ?? 'ignore', err ?? 'ignore'], windowsHide: true });
  p.on('error', () => {});   // a failed start leaves pid undefined
  p.unref();
  return p.pid;
}

// open::that_detached — returns true when a browser launcher was started.
export function openUrl(url) {
  if (process.env.ONCHAINOS_NO_BROWSER !== undefined || process.env.OCL_NO_BROWSER !== undefined) return false;
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return !!p.pid;
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const which = (bin) => { try { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0; } catch { return false; } };
