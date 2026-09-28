// PRIVATE — std::process::Command semantics for the agent ports: external programs
// (`okx-a2a`), the `cmd /C` npm-shim wrapper, and self-invocation of this CLI (upstream spawns
// `std::env::current_exe()`). Results mirror `Command::output()`: raw stdout/stderr bytes,
// the exit code, or the spawn error.
import { spawn } from 'node:child_process';
import { ENTRY } from '../core/proc.mjs';

// Command::new(program).args(args).output() → { spawnError?, code, signal, stdout: Buffer, stderr: Buffer, timedOut? }
// timeoutMs: kill after the deadline (output_with_timeout / tokio::time::timeout); 0 = none.
export function output(program, args, { timeoutMs = 0, env } = {}) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    } catch (e) {
      resolve({ spawnError: e, code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
    const out = [], err = [];
    let done = false, timedOut = false, timer;
    const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; try { p.kill(); } catch {} }, timeoutMs);
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    p.on('error', (e) => finish({ spawnError: e, code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    p.on('close', (code, signal) => finish({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut }));
  });
}

// okx_a2a.rs::npm_cli_command — Windows routes through `cmd /C` so npm `.cmd` shims resolve.
export function npmCliCommand(program, args) {
  return process.platform === 'win32' ? ['cmd', ['/C', program, ...args]] : [program, args];
}
export const npmOutput = (program, args, opts) => { const [p, a] = npmCliCommand(program, args); return output(p, a, opts); };

// `Command::new(current_exe()).args(args).output()` — this runtime re-invoked (env inherited).
export const selfOutput = (args, opts) => output(process.execPath, [ENTRY, ...args], opts);

export const utf8Lossy = (buf) => Buffer.from(buf).toString('utf8');
