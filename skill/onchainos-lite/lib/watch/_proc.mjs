// Private fallback (request: core/proc.mjs spawnSelfDetached with separate stdout/stderr).
// upstream ws.rs::ws_start spawns `current_exe ws run-daemon --id <id>` with stdin = null,
// stdout = null, stderr = <dir>/daemon.log, DETACHED_PROCESS on Windows — so a failing
// daemon's `{"ok":false,…}` line goes nowhere and daemon.log only holds its stderr.
import { spawn } from 'node:child_process';
import { ENTRY } from '../core/proc.mjs';

// → child pid, or undefined when the process could not be started.
export function spawnSelfDetachedStdio(args, { stdout = 'ignore', stderr = 'ignore', env } = {}) {
  const p = spawn(process.execPath, [ENTRY, ...args], {
    env: { ...process.env, ...env }, detached: true, stdio: ['ignore', stdout, stderr], windowsHide: true,
  });
  p.on('error', () => {});
  p.unref();
  return p.pid;
}
