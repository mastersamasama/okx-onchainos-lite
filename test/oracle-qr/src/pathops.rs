//! std::path vectors (components, next_back, as_path, parent, has_root /
//! is_absolute, strip_prefix, join) over curated and fuzzed inputs.
//!
//! Shared by the Windows oracle (src/main.rs → `paths.win` in vectors.json) and
//! the wasm32 build in unix-paths/ (std's unix path module → vectors-paths-unix.json),
//! so lib/core/qr.mjs can check both flavours of its std::path port on any host.

use serde_json::{json, Value};
use std::path::{Component, Path, Prefix};

pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    pub fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn comp_json(c: &Component) -> Value {
    match c {
        Component::Prefix(p) => {
            let s = |x: &std::ffi::OsStr| x.to_string_lossy().into_owned();
            let (kind, a, b) = match p.kind() {
                Prefix::Verbatim(x) => ("Verbatim", s(x), String::new()),
                Prefix::VerbatimUNC(x, y) => ("VerbatimUNC", s(x), s(y)),
                Prefix::VerbatimDisk(d) => ("VerbatimDisk", (d as char).to_string(), String::new()),
                Prefix::DeviceNS(x) => ("DeviceNS", s(x), String::new()),
                Prefix::UNC(x, y) => ("UNC", s(x), s(y)),
                Prefix::Disk(d) => ("Disk", (d as char).to_string(), String::new()),
            };
            json!(["prefix", kind, s(p.as_os_str()), a, b])
        }
        Component::RootDir => json!(["root"]),
        Component::CurDir => json!(["cur"]),
        Component::ParentDir => json!(["parent"]),
        Component::Normal(s) => json!(["normal", s.to_string_lossy()]),
    }
}

fn path_json(p: &str) -> Value {
    let path = Path::new(p);
    let mut after_next = path.components();
    after_next.next();
    let mut after_back = path.components();
    after_back.next_back();
    json!({
        "p": p,
        "comps": path.components().map(|c| comp_json(&c)).collect::<Vec<_>>(),
        "rev": path.components().rev().map(|c| comp_json(&c)).collect::<Vec<_>>(),
        "asPath": lossy(path.components().as_path()),
        "asPathAfterNext": lossy(after_next.as_path()),
        "asPathAfterBack": lossy(after_back.as_path()),
        "parent": path.parent().map(lossy),
        "hasRoot": path.has_root(),
        "abs": path.is_absolute(),
    })
}

fn pair_json(a: &str, b: &str) -> Value {
    json!({
        "a": a,
        "b": b,
        "strip": Path::new(a).strip_prefix(b).ok().map(lossy),
        "join": lossy(&Path::new(a).join(b)),
    })
}

const WIN_PREFIXES: &[&str] = &[
    "", "", "", "C:", "c:", "C:\\", "C:/", "Q:", "\\", "/", "\\\\srv\\sh", "\\\\srv\\sh\\", "//srv/sh/", "\\\\srv",
    "\\\\srv\\", "\\\\", "\\\\?\\C:\\", "\\\\?\\C:", "\\\\?\\c:/", "\\\\?\\UNC\\srv\\sh\\", "\\\\?\\UNC/srv", "\\\\?\\UNC\\",
    "\\\\?\\pipe\\", "\\\\?\\", "\\\\?/", "//?/C:/", "\\\\.\\COM1\\", "\\\\.\\C:\\", "//./C:/", "\\\\.\\", "\\??\\C:\\",
    ".", ".\\", "./", "..",
];
const WIN_TOKENS: &[&str] = &["a", "bb", ".", "..", "...", "a.", "a..", "a .", " ", "a ", " a", "x.y", "", "é", "C:", "?", "UNC"];
const WIN_SEPS: &[&str] = &["\\", "\\", "/", "\\\\", "/\\", "//"];

const UNIX_PREFIXES: &[&str] = &["", "", "/", "/", "//", "///", ".", "./", "..", "../", ".//", "~", "C:\\", "\\\\srv\\sh\\"];
const UNIX_TOKENS: &[&str] = &["a", "bb", ".", "..", "...", "a.", " ", "a b", "x\\y", "", "é", "C:"];
const UNIX_SEPS: &[&str] = &["/", "/", "/", "//", "///", "\\"];

pub fn fuzz_paths(win: bool, n: usize, seed: u64) -> Vec<String> {
    let (prefixes, tokens, seps) =
        if win { (WIN_PREFIXES, WIN_TOKENS, WIN_SEPS) } else { (UNIX_PREFIXES, UNIX_TOKENS, UNIX_SEPS) };
    let mut rng = Rng(seed);
    (0..n)
        .map(|_| {
            let mut s = rng.pick(prefixes).to_string();
            let parts = rng.below(5);
            for i in 0..parts {
                if i > 0 {
                    s.push_str(rng.pick(seps));
                }
                s.push_str(rng.pick(tokens));
            }
            if rng.below(4) == 0 {
                s.push_str(rng.pick(seps));
            }
            s
        })
        .collect()
}

pub const WIN_CURATED: &[&str] = &[
    "", ".", "..", "C:", "c:", "C:\\", "C:/", "C:a", "C:.\\a", "C:..\\a", "\\", "/", "\\a", "/a", "a", "a\\", "a/", ".\\a",
    "./a", "..\\a", "a\\.\\b", "a\\..\\b", "a\\\\b", "a/./b/", "C:\\a\\", "C:\\a\\.", "C:\\a\\..", "C:\\a\\.\\",
    "C:\\a\\\\", "C:\\a\\\\b\\\\", "C:\\.", "C:\\..", "\\\\srv\\sh", "\\\\srv\\sh\\", "\\\\srv\\sh\\a", "//srv/sh/a",
    "\\\\srv", "\\\\srv\\", "\\\\", "\\\\\\a", "\\\\?\\C:", "\\\\?\\C:\\", "\\\\?\\C:\\a\\.\\b", "\\\\?\\C:\\a\\\\b",
    "\\\\?\\C:/a", "\\\\?\\c:\\x", "\\\\?\\C:x", "\\\\?\\UNC\\srv\\sh\\a", "\\\\?\\UNC\\srv", "\\\\?\\UNC\\",
    "\\\\?\\UNC/srv/sh", "\\\\?\\pipe\\x", "\\\\?\\", "\\\\?/C:/a", "//?/C:/a", "\\\\.\\COM1", "\\\\.\\C:\\a", "//./C:/a",
    "\\\\.\\", "\\??\\C:\\a", "D:\\Job\\x\\.onchainos\\tmp\\funding-qr\\f.png", "D:\\Job\\x", "D:\\Job\\x\\",
    "\\\\?\\D:\\Job\\x\\vd\\\\y", "\\\\?\\D:\\Job\\x\\vdot\\.", "\\\\?\\D:\\Job\\x\\vt\\", "C:\\Users\\u\\AppData\\Local\\Temp\\",
];
pub const UNIX_CURATED: &[&str] = &[
    "", ".", "..", "/", "//", "///", "/a", "//a", "///a", "a", "a/", "./a", "../a", "a/./b", "a/../b", "a//b", "/a/", "/a/.",
    "/a/..", "/a/./", "./", ".//a", "a\\b", "C:\\a", "/home/u/w/.onchainos/tmp/funding-qr/f.png", "/home/u/w", "/home/u/w/",
    "/tmp", "/tmp/", "~/x", ". /a", "/./a", "/../a",
];

/// `{paths: [...], pairs: [...]}` for one flavour.
pub fn vectors(win: bool) -> Value {
    let curated = if win { WIN_CURATED } else { UNIX_CURATED };
    let mut all: Vec<String> = curated.iter().map(|s| s.to_string()).collect();
    all.extend(fuzz_paths(win, 700, if win { 0x51ed_27a1_0bb5_c0de } else { 0x7a3c_91e4_55d0_1b2f }));
    let paths: Vec<Value> = all.iter().map(|p| path_json(p)).collect();

    let mut pairs = Vec::new();
    // curated x curated (small), then fuzz pairs biased towards shared prefixes.
    for a in curated {
        for b in curated.iter().step_by(3) {
            pairs.push(pair_json(a, b));
        }
    }
    let mut rng = Rng(if win { 0x0dd_ba11 } else { 0xca11_ab1e });
    for _ in 0..1500 {
        let a = &all[rng.below(all.len())];
        let b: String = match rng.below(4) {
            0 => all[rng.below(all.len())].clone(),
            1 => {
                // a cut of `a` at a char boundary
                let chars: Vec<char> = a.chars().collect();
                chars[..rng.below(chars.len() + 1)].iter().collect()
            }
            2 => {
                let chars: Vec<char> = a.chars().collect();
                let cut: String = chars[..rng.below(chars.len() + 1)].iter().collect();
                format!("{cut}{}", if win { rng.pick(WIN_SEPS) } else { rng.pick(UNIX_SEPS) })
            }
            _ => {
                let t = if win { WIN_TOKENS } else { UNIX_TOKENS };
                rng.pick(t).to_string()
            }
        };
        pairs.push(pair_json(a, &b));
    }
    json!({ "paths": paths, "pairs": pairs })
}
