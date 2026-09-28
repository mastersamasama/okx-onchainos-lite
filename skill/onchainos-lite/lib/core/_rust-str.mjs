// Private helpers reproducing Rust std string/number semantics that the core-helper
// ports depend on (JS equivalents differ at the edges):
//   - str::trim uses char::is_whitespace (Unicode White_Space): includes U+0085,
//     excludes U+FEFF — JS String.prototype.trim does the opposite on both.
//   - to_ascii_lowercase / to_ascii_uppercase touch only A-Z / a-z.
//   - f64 / u64 / u32 FromStr grammars (no surrounding whitespace, optional sign rules).
// Owned by core-helpers; candidate for promotion to a shared core module.

const WS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// str::trim_start / str::trim_end / str::trim (all White_Space chars are BMP → one code unit)
export function trimStart(s) {
  let i = 0;
  while (i < s.length && WS.has(s.charCodeAt(i))) i++;
  return s.slice(i);
}
export function trimEnd(s) {
  let j = s.length;
  while (j > 0 && WS.has(s.charCodeAt(j - 1))) j--;
  return s.slice(0, j);
}
export const trim = (s) => trimEnd(trimStart(String(s)));

// str::to_ascii_lowercase / to_ascii_uppercase / eq_ignore_ascii_case
export const asciiLower = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
export const asciiUpper = (s) => String(s).replace(/[a-z]/g, (c) => c.toUpperCase());
export const eqIgnoreAsciiCase = (a, b) => a.length === b.length && asciiLower(a) === asciiLower(b);

// char::is_ascii_alphanumeric / is_ascii_hexdigit / is_ascii_uppercase
export const isAsciiAlnum = (c) => /^[0-9A-Za-z]$/.test(c);
export const isAsciiHex = (c) => /^[0-9A-Fa-f]$/.test(c);
export const isAsciiUpper = (c) => /^[A-Z]$/.test(c);
export const allAsciiDigits = (s) => /^[0-9]*$/.test(s);

// str::len — UTF-8 byte length.
export const byteLen = (s) => Buffer.byteLength(s, 'utf8');

// <f64 as FromStr>::from_str → number, or undefined on a parse error.
// Grammar: [+-]? (inf | infinity | nan | (digits[.digits?] | .digits)([eE][+-]?digits)?), ASCII case-insensitive words.
export function parseF64(s) {
  const m = /^([+-]?)(?:(inf|infinity|nan)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))$/i.exec(s);
  if (!m) return undefined;
  if (m[2]) {
    const w = m[2].toLowerCase();
    if (w === 'nan') return NaN;
    return m[1] === '-' ? -Infinity : Infinity;
  }
  return Number(m[1] + m[3]);
}

// <u64 / u32 as FromStr>::from_str → number (BigInt beyond 2^53), or undefined on error
// (empty, non-digit, a '-' sign, or out of range). A single leading '+' is accepted.
const UMAX = { u32: 4294967295n, u64: 18446744073709551615n };
export function parseUnsigned(s, type = 'u64') {
  if (!/^\+?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s.startsWith('+') ? s.slice(1) : s);
  if (v > UMAX[type]) return undefined;
  return Number.isSafeInteger(Number(v)) ? Number(v) : v;
}
