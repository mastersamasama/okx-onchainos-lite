// PRIVATE (autotrade): anyhow semantics.
//   bail!(msg)                 → plain Error(msg)
//   result.context(msg)        → ctx(msg, cause): `{e:#}` = "msg: cause-chain", `e.to_string()` = msg
//   option.context(msg)        → plain Error(msg) (no cause)
// outerMessage(e) = anyhow `e.to_string()` (outermost context only).
import { CliError } from '../../../../core/errors.mjs';

export function ctx(msg, cause) {
  const e = new CliError(`${msg}: ${cause?.message ?? cause}`);
  e.cause = cause;
  e.outer = msg;
  return e;
}

export function outerMessage(e) {
  if (e && typeof e.outer === 'string') return e.outer;
  const m = e?.message ?? String(e);
  const c = e?.cause;
  if (c && typeof c.message === 'string' && m.endsWith(`: ${c.message}`)) return m.slice(0, m.length - c.message.length - 2);
  return m;
}
