// std::process semantics: Command::spawn failure Display and ExitStatus Display.
// (`ExitStatus::code()` Debug is str.mjs `debugOptInt`.)
import { ioErrorText } from './fs.mjs';

// io::Error Display of a failed Command::spawn (program lookup failure).
export function spawnErrorText(e) {
  if (e?.code === 'ENOENT') return process.platform === 'win32' ? 'program not found' : 'No such file or directory (os error 2)';
  if (e?.code === 'EACCES') return process.platform === 'win32' ? 'Access is denied. (os error 5)' : 'Permission denied (os error 13)';
  return ioErrorText(e);
}
// ExitStatus Display ("exit code: N" on Windows, "exit status: N" / "signal: N (SIG…)" on Unix).
export function exitStatusText(code, signal) {
  if (process.platform === 'win32') return `exit code: ${code ?? 1}`;
  if (code === null || code === undefined) {
    const n = { SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGABRT: 6, SIGSEGV: 11, SIGHUP: 1, SIGPIPE: 13 }[signal];
    return n ? `signal: ${n} (${signal})` : `signal: ${signal}`;
  }
  return `exit status: ${code}`;
}
