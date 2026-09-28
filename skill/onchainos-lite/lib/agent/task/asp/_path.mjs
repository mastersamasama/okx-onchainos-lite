// PRIVATE — std::path semantics the ASP ports need (candidate for promotion next to
// evaluator/helpers.mjs::pathBufPush into a shared Rust-path module).

const WIN = process.platform === 'win32';
const isSep = (c) => c === '/' || (WIN && c === '\\');

// `Path::file_name` → last Normal component, or undefined (None) for `..`, a root, a bare
// prefix or an empty path. Unlike Node's basename, trailing `.` components are skipped
// (`foo/.` → `foo`), exactly as `Path::components` does.
export function rustFileName(p) {
  let s = String(p);
  let prefixLen = 0;
  if (WIN) {
    const m = /^(?:[\\/]{2}[^\\/]+[\\/][^\\/]*|[A-Za-z]:)/.exec(s);
    if (m) prefixLen = m[0].length;
  }
  for (;;) {
    let end = s.length;
    while (end > prefixLen && isSep(s[end - 1])) end--;
    s = s.slice(0, end);
    let start = end;
    while (start > prefixLen && !isSep(s[start - 1])) start--;
    const last = s.slice(start, end);
    if (last === '.' && start > prefixLen) { s = s.slice(0, start); continue; }
    if (last === '' || last === '.' || last === '..') return undefined;
    return last;
  }
}
