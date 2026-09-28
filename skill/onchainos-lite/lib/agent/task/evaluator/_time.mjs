// PRIVATE — chrono Local formatting used by the evaluator ports:
// `Local.timestamp_opt(ts, 0).single().map(|d| d.format("%Y-%m-%d %H:%M:%S %Z"))`
// (`%Z` of `Local` renders the fixed offset, e.g. `+08:00`).
import { localParts } from '../../_rs.mjs';

const p2 = (n) => String(n).padStart(2, '0');
const yearText = (y) => (y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : (y < 0 ? '-' : '+') + String(Math.abs(y)).padStart(4, '0'));

function offsetText(off) {
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const base = `${sign}${p2(Math.floor(a / 3600))}:${p2(Math.floor((a % 3600) / 60))}`;
  return a % 60 ? `${base}:${p2(a % 60)}` : base;
}

// → formatted local time | undefined (timestamp out of chrono's range)
export function fmtLocalYmdHmsZ(ts) {
  const p = localParts(ts);
  if (!p) return undefined;
  return `${yearText(p.y)}-${p2(p.m)}-${p2(p.d)} ${p2(p.hh)}:${p2(p.mm)}:${p2(p.ss)} ${offsetText(p.off)}`;
}
