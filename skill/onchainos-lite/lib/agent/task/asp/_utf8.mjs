// PRIVATE — Rust std Display text not yet available in a shared module (candidate for
// promotion to lib/agent/_rs.mjs): `core::str::Utf8Error` as produced by `String::from_utf8`.

// Rust `core::str::Utf8Error` Display for the first invalid sequence, or undefined when the
// bytes are valid UTF-8 (`String::from_utf8` semantics, incl. `error_len` maximal subparts).
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
