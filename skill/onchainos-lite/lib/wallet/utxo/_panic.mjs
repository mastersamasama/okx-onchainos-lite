// PRIVATE — Rust panic emulation for the few upstream `unreachable!` / `.expect(..)` sites this
// unit ports (receive.rs, utxo/brc20.rs). The release profile is `panic = "abort"`: the default
// hook prints the panic message to stderr and the process aborts (Windows fast-fail status
// 0xC0000409, SIGABRT elsewhere) — no JSON envelope, no audit record. Candidate for core.
import { sep } from 'node:path';

// `src/<file>` as file!() records it on the build host (backslashes on Windows builds).
export function rustPanic(file, line, column, message) {
  const location = ['src', ...file.split('/')].join(sep);
  // The release build's panic output starts with an empty line (observed on 4.6.3).
  process.stderr.write(`\nthread '<unnamed>' (${process.pid}) panicked at ${location}:${line}:${column}:\n${message}\n`
    + 'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n');
  if (process.platform === 'win32') process.exit(0xC0000409);
  process.abort();
}
