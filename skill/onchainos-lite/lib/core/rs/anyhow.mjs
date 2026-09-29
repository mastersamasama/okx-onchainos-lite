// anyhow semantics over lite errors (core/errors.mjs `context()` keeps the wrapped error in
// `.cause` and prints "outer: inner", like anyhow's `{:#}`).
import { CliError } from '../errors.mjs';

// anyhow::Error::downcast::<E>() — also succeeds through `.context()` layers.
export function downcast(e, Type) {
  for (let cur = e, depth = 0; cur && depth < 16; cur = cur.cause, depth++) if (cur instanceof Type) return cur;
  return undefined;
}
// `format!("{}", anyhow_error)` — the outermost message only (no `: cause` chain).
export function outermost(e) {
  if (e instanceof CliError && e.cause !== undefined) {
    const inner = `: ${e.cause?.message ?? e.cause}`;
    if (e.message.endsWith(inner)) return e.message.slice(0, -inner.length);
  }
  return e?.message ?? String(e);
}
