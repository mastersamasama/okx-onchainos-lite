// PRIVATE — Rust std behaviours the identity / chat ports need.

const WIN = process.platform === 'win32';

// std::sys::path::windows::parse_prefix → [prefixLength, verbatim] (length 0 = no prefix).
// Only the prefix kinds matter here: Verbatim `\\?\x`, VerbatimUNC `\\?\UNC\srv\share`,
// VerbatimDisk `\\?\C:`, DeviceNS `\\.\x`, UNC `\\srv\share` (either separator) and Disk `C:`.
function windowsPrefix(s) {
  // PrefixParser normalises '/' to '\' in the first 8 bytes before matching.
  const head = s.slice(0, 8).replace(/\//g, '\\');
  const nextComponent = (i, verbatim) => {
    let j = i;
    while (j < s.length && !(s[j] === '\\' || (!verbatim && s[j] === '/'))) j++;
    return j;
  };
  if (head.startsWith('\\\\')) {
    if (head.startsWith('\\\\?\\') && !s.slice(0, 4).includes('/')) {
      if (head.startsWith('\\\\?\\UNC\\')) {
        const serverEnd = nextComponent(8, true);
        if (serverEnd >= s.length) return [serverEnd, true];
        const shareEnd = nextComponent(serverEnd + 1, true);
        return [shareEnd > serverEnd + 1 ? shareEnd : serverEnd, true];
      }
      // parse_drive_exact: `X:` followed by a verbatim separator or the end.
      if (/^[A-Za-z]:/.test(s.slice(4, 6)) && (s.length === 6 || s[6] === '\\')) return [6, true];
      return [nextComponent(4, true), true];
    }
    if (head.startsWith('\\\\.\\')) return [nextComponent(4, false), false];
    const serverEnd = nextComponent(2, false);
    if (serverEnd > 2 && serverEnd < s.length) {
      const shareEnd = nextComponent(serverEnd + 1, false);
      if (shareEnd > serverEnd + 1) return [shareEnd, false];
    }
    return [0, false];
  }
  return /^[A-Za-z]:/.test(s) ? [2, false] : [0, false];
}

// std::path::Path::file_name → the last Normal component as UTF-8, undefined when the path is
// empty, only a root / prefix (`C:\`, `\\srv\share`), or ends in `..`. `.` components are
// normalised away (they are CurDir in verbatim paths, which also yields no file name).
// Windows separates on both `\` and `/` (verbatim `\\?\` paths on `\` only), Unix on `/`.
export function fileName(p) {
  let s = String(p), verbatim = false;
  if (WIN) {
    const [len, v] = windowsPrefix(s);
    s = s.slice(len);
    verbatim = v;
  }
  const sep = !WIN ? /\// : verbatim ? /\\/ : /[\\/]/;
  const parts = s.split(sep).filter((x) => x !== '' && (verbatim || x !== '.'));
  const last = parts[parts.length - 1];
  if (last === undefined || last === '..' || last === '.') return undefined;
  return last;
}
