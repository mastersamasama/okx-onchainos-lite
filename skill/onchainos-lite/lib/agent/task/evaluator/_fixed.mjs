// PRIVATE — Rust `format!("{:.N}", f64)` (candidate for promotion to lib/agent/_rs.mjs; the same
// algorithm exists privately as wallet/_rs.mjs::formatFixed and user/asp-ops.mjs::rustFixed).
// core::fmt renders the exact binary value of the double and rounds ties to even, so e.g.
// `format!("{:.2}", 0.125)` is "0.12" where JS `(0.125).toFixed(2)` gives "0.13".

// Rust `format!("{:.prec$}", x)` for an f64 `x`.
export function rustFixed(x, prec) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  // value = mant * 2^exp
  const mant = expBits === 0 ? frac : frac | (1n << 52n);
  const exp = expBits === 0 ? -1074 : expBits - 1075;
  // scaled = value * 10^prec = num / den
  let num = mant * 10n ** BigInt(prec), den = 1n;
  if (exp >= 0) num <<= BigInt(exp); else den <<= BigInt(-exp);
  let q = num / den;
  const r = num % den;
  if (r * 2n > den || (r * 2n === den && (q & 1n) === 1n)) q += 1n;
  let s = q.toString().padStart(prec + 1, '0');
  if (prec > 0) s = `${s.slice(0, -prec)}.${s.slice(-prec)}`;
  return (neg ? '-' : '') + s;
}
