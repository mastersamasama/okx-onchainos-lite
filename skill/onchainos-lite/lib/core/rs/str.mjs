// Rust `str` / `char` semantics where the JS built-ins differ at the edges:
//   - char::is_whitespace is Unicode White_Space: U+0085 counts, U+FEFF does not (the reverse
//     of String.prototype.trim);
//   - ASCII case mapping touches A-Z / a-z only; `len()` counts UTF-8 bytes;
//   - `Ord` for str compares UTF-8 bytes, not UTF-16 code units;
//   - `{:?}` escapes like char::escape_debug.

// Every White_Space char is in the BMP, so one UTF-16 code unit each.
const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// char::is_whitespace (a one-char string or a code point)
export const isWhitespace = (c) => WHITE_SPACE.has(typeof c === 'number' ? c : c.charCodeAt(0));

// str::trim_start / str::trim_end / str::trim
export function trimStart(s) {
  s = String(s);
  let i = 0;
  while (i < s.length && WHITE_SPACE.has(s.charCodeAt(i))) i++;
  return s.slice(i);
}
export function trimEnd(s) {
  s = String(s);
  let j = s.length;
  while (j > 0 && WHITE_SPACE.has(s.charCodeAt(j - 1))) j--;
  return s.slice(0, j);
}
export const trim = (s) => trimEnd(trimStart(s));

// str::trim_start_matches(pat) — strips every leading repetition.
export function trimStartMatches(s, pat) {
  let t = String(s);
  while (pat !== '' && t.startsWith(pat)) t = t.slice(pat.length);
  return t;
}

// str::to_ascii_lowercase / to_ascii_uppercase / eq_ignore_ascii_case
export const asciiLower = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
export const asciiUpper = (s) => String(s).replace(/[a-z]/g, (c) => c.toUpperCase());
export const eqIgnoreAsciiCase = (a, b) => a.length === b.length && asciiLower(a) === asciiLower(b);

// char::is_ascii_alphanumeric / is_ascii_hexdigit / is_ascii_uppercase
export const isAsciiAlnum = (c) => /^[0-9A-Za-z]$/.test(c);
export const isAsciiHex = (c) => /^[0-9A-Fa-f]$/.test(c);
export const isAsciiUpper = (c) => /^[A-Z]$/.test(c);
// `s.chars().all(|c| c.is_ascii_digit())` — true for "".
export const allAsciiDigits = (s) => /^[0-9]*$/.test(s);
// char::is_control (Unicode Cc)
export const isControl = (ch) => { const c = ch.codePointAt(0); return c <= 0x1f || (c >= 0x7f && c <= 0x9f); };
// char::is_alphanumeric (Unicode Alphabetic || Numeric)
export const isAlphanumeric = (ch) => /[\p{Alphabetic}\p{N}]/u.test(ch);

// str::len (UTF-8 bytes) / str::chars().count()
export const byteLen = (s) => Buffer.byteLength(String(s), 'utf8');
export const charCount = (s) => [...String(s)].length;

// Ord for str / String: UTF-8 byte order.
export const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
// Vec::sort + Vec::dedup (consecutive duplicates) under `cmp`.
export function sortDedup(list, cmp = cmpBytes) {
  const s = [...list].sort(cmp);
  return s.filter((x, i) => i === 0 || cmp(s[i - 1], x) !== 0);
}

// str::split_whitespace
export function splitWhitespace(s) {
  const out = [];
  let cur = '';
  for (const ch of String(s)) {
    if (isWhitespace(ch)) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
// str::lines — splits on \n, strips a trailing \r of each line, no final empty line.
export function lines(s) {
  const parts = String(s).split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
// str::splitn(n, sep)
export function splitn(s, n, sep) {
  const out = [];
  let rest = s;
  while (out.length < n - 1) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

// char::escape_debug_ext (escape_grapheme_extended, as both Debug impls use it): backslash escapes,
// the quote of the literal kind, then \u{…} for Grapheme_Extend chars and the non-printable ones
// (general categories Cc Cf Cs Co Cn Zl Zp, and Zs other than ' ').
const BACKSLASH_ESCAPES = new Map([['\0', '\\0'], ['\t', '\\t'], ['\n', '\\n'], ['\r', '\\r'], ['\\', '\\\\']]);
const UNICODE_ESCAPED = /^(?:[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs}|\p{Grapheme_Extend})$/u;
function escapeDebug(ch, quote) {
  if (ch === quote) return `\\${ch}`;
  return BACKSLASH_ESCAPES.get(ch) ?? (UNICODE_ESCAPED.test(ch) ? `\\u{${ch.codePointAt(0).toString(16)}}` : ch);
}
// <char as Debug> — 'x', '\n', '\u{7f}'
export const charDebug = (ch) => `'${escapeDebug(ch, "'")}'`;
// <str as Debug> — "…"
export function strDebug(s) {
  let out = '"';
  for (const ch of String(s)) out += escapeDebug(ch, '"');
  return out + '"';
}
// <Option<i64> as Debug> / <Option<&str> as Debug>
export const debugOptInt = (v) => (v === undefined || v === null ? 'None' : `Some(${v})`);
export const debugOptStr = (v) => (v === undefined || v === null ? 'None' : `Some(${strDebug(v)})`);

// core::str::Utf8Error Display for the first invalid sequence of `bytes` (String::from_utf8
// semantics, incl. `error_len` maximal subparts), or undefined when the bytes are valid UTF-8.
export function utf8ErrorText(bytes) {
  const v = bytes, len = v.length;
  let i = 0;
  const width = (b) => (b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0);
  const cont = (b) => b >= 0x80 && b <= 0xbf;
  while (i < len) {
    const start = i, first = v[i];
    const err = (n) => (n === undefined ? `incomplete utf-8 byte sequence from index ${start}` : `invalid utf-8 sequence of ${n} bytes from index ${start}`);
    if (first < 0x80) { i++; continue; }
    const w = width(first);
    const next = () => { i++; return i >= len ? undefined : v[i]; };
    if (w === 2) {
      const b = next(); if (b === undefined) return err(); if (!cont(b)) return err(1);
    } else if (w === 3) {
      const b = next(); if (b === undefined) return err();
      const ok = (first === 0xe0 && b >= 0xa0 && b <= 0xbf) || (first >= 0xe1 && first <= 0xec && cont(b)) || (first === 0xed && b >= 0x80 && b <= 0x9f) || (first >= 0xee && first <= 0xef && cont(b));
      if (!ok) return err(1);
      const c = next(); if (c === undefined) return err(); if (!cont(c)) return err(2);
    } else if (w === 4) {
      const b = next(); if (b === undefined) return err();
      const ok = (first === 0xf0 && b >= 0x90 && b <= 0xbf) || (first >= 0xf1 && first <= 0xf3 && cont(b)) || (first === 0xf4 && b >= 0x80 && b <= 0x8f);
      if (!ok) return err(1);
      const c = next(); if (c === undefined) return err(); if (!cont(c)) return err(2);
      const d = next(); if (d === undefined) return err(); if (!cont(d)) return err(3);
    } else return err(1);
    i++;
  }
  return undefined;
}
