//! Vector oracle for `skill/onchainos-lite/lib/core/qr.mjs`.
//!
//! Uses the exact `qrcode` 0.14.1 crate (default-features = false, as upstream
//! cli/Cargo.toml) plus verbatim copies of the upstream `cli/src/qr.rs` (4.6.3)
//! render / PNG / Codex-metadata functions, and writes `vectors.json`.
//!
//!   cargo run --release --offline -- ../oracle-qr/vectors.json
//!
//! Only functions marked "verbatim" are byte-for-byte copies of upstream; the
//! `*_bytes` variants are the same code taking `&[u8]` so non-UTF-8 inputs can
//! exercise the encoder's Shift-JIS/Kanji state machine.

use qrcode::{render::unicode, Color as QrColor, QrCode, Version};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

mod pathops;

/// Win32 path normalisation (`GetFullPathNameW`), which every non-verbatim path
/// upstream hands to CreateFileW / CreateDirectoryW / GetTempPath2W goes through.
#[cfg(windows)]
mod win {
    use serde_json::{json, Value};
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFullPathNameW(name: *const u16, len: u32, buf: *mut u16, file_part: *mut *mut u16) -> u32;
    }

    pub const CWD: &str = "C:\\Windows\\System32";

    pub fn full_path(p: &str) -> Option<String> {
        let wide: Vec<u16> = std::ffi::OsStr::new(p).encode_wide().chain(Some(0)).collect();
        let mut buf = vec![0u16; 32768];
        let n = unsafe { GetFullPathNameW(wide.as_ptr(), buf.len() as u32, buf.as_mut_ptr(), std::ptr::null_mut()) };
        if n == 0 {
            return None;
        }
        Some(OsString::from_wide(&buf[..n as usize]).to_string_lossy().into_owned())
    }

    /// `{cwd, path, out}` with the process cwd pinned to CWD (drive C:; no `=Q:` variable).
    pub fn full_path_vectors() -> Vec<Value> {
        std::env::set_current_dir(CWD).expect("set cwd");
        let curated = [
            "C:\\a\\foo.", "C:\\a\\foo..", "C:\\a\\foo...", "C:\\a\\foo. .", "C:\\a\\foo .\\b", "C:\\a\\foo.\\b",
            "C:\\a\\foo..\\b", "C:\\a\\...\\b", "C:\\a\\ \\b", "C:\\a\\ ", "C:\\a\\ .", "C:\\a\\.", "C:\\a\\..",
            "C:\\a\\..\\..\\..", "C:/a//b/", "C:\\a\\b\\", "C:\\a\\b.\\", "C:\\a\\b \\", "C:\\a\\b\\..\\", "C:\\a.\\..\\b",
            "C:\\a\\ .\\b", "C:\\a\\b. \\c", "C:\\a\\.b\\", "C:\\a\\..b", "C:\\a\\b..\\..\\c", "\\\\?\\C:\\a\\\\b",
            "\\\\?\\C:\\a\\.\\b", "\\\\?\\C:\\a\\..\\b", "\\\\?\\C:\\a/b", "\\\\?\\C:\\a\\foo.", "\\\\?\\C:\\..\\..",
            "\\\\?\\UNC\\srv\\sh\\a\\\\b", "\\\\?\\UNC\\srv\\sh\\..\\..\\x", "\\\\.\\C:\\a\\..\\b", "\\\\.\\C:\\..\\..\\b",
            "\\\\.\\COM1", "\\\\.", "\\\\?", "\\\\.\\", "\\\\?\\", "\\\\srv\\sh\\a\\..\\..\\b", "\\\\srv\\sh", "\\\\srv",
            "\\\\srv\\", "\\\\srv\\sh\\", "\\\\srv\\sh\\.", "\\\\srv\\sh\\..", "//srv/sh/x", "\\\\", "\\\\\\a", "\\??\\C:\\a",
            "C:", "C:.", "C:..", "C:rel\\x", "c:rel", "Q:", "Q:rel\\x", "Q:..\\..", "rel\\x.", ".\\x", "..\\x", "..\\..\\..\\x",
            "\\x", "/x", "\\..\\x", " ", "", "   ", "\t", "...", ". ", " .", "  C:\\a  ", "C:\\a\\b:c", "C:\\a\\con",
            "C:\\a\\nul.txt", "C:\\a\\CON\\b", "C:\\a\\*", "C:\\a\\foo\u{3000}", "C:\\a\\foo\t", "C:\\a\\é.", "a/b\\c//d",
            // roots: what `.`/`..` and trailing dots may consume after \\server\share, \\.\ and X:\
            r"\\srv\sh\.", r"\\srv\sh\..", r"\\srv\sh\a\..", r"\\srv\sh\a\..\..", r"\\srv\sh\..\a", r"\\srv\sh\.\a",
            r"\\srv\sh\a\.", r"\\srv\sh\ ", r"\\srv\sh\..\..\a", r"\\srv\sh.\a", r"\\srv\sh \a", r"\\srv\sh..\a",
            r"\\srv.\sh", r"\\srv\sh\\\a", r"\\srv\\sh", r"\\srv\.", r"\\srv\..", r"\\srv\.\a", r"\\srv\..\a",
            r"\\srv\a\..\..\b", r"\\.\C:\.", r"\\.\C:\..", r"\\.\C:\..\a", r"\\.\C:\..\..\a", r"\\.\.", r"\\.\..",
            r"\\.\..\a", r"\\.\a\..", r"\\?\C:\..", r"\\?\C:\.", r"\\?\UNC\srv\sh\..\..\a", r"C:\.", r"C:\..", r"C:\..\a",
            r"C:\.\a", r"C:\ ", r"C:\.. ", r"C:\a\..", r"C:\a\..\", r"C:\a\.\", r"\\.\C:", r"\\.\C:.", r"\\?\C:",
            r"\\srv\sh.", r"\\srv\sh\a.", r"\\srv\sh\a.\b", r"\\srv\sh\.\", r"\\srv\sh\..\", r"\\srv\\", r"\\srv\\\a",
            r"\\srv\sh\a\..\", r"\\srv\sh\.\.\a", r"\\srv\sh\ \..\a", r"\\srv\sh\x.\..\a", r"\\.\C:\a\.",
            r"\\.\C:\a\..\..", r"\\?\C:\a\..\..", r"\\srv\sh\a..\..", r"C:\a..\..", r"C:\a.\.", r"\\srv\sh\...",
            r"\\srv\sh\a\...", r"C:\...", r"\\.\...", r"\\.\C:\...", r"\\srv\\sh\..", r"\\srv\\sh\a\..\..",
        ];
        let prefixes = [
            "", "", "C:", "c:", "Q:", "C:\\", "C:/", "Q:\\", "\\", "/", "\\\\srv\\sh\\", "//srv/sh", "\\\\srv", "\\\\?\\C:\\",
            "\\\\.\\C:\\", "\\\\?\\UNC\\srv\\sh\\", "\\??\\C:\\", " ", "  ", ".", "..\\",
        ];
        let tokens = ["a", "b", ".", "..", "...", "a.", "a..", "a. .", "a .", " ", "  ", "a ", " a", ". ", " .", "x.y", "", "\t", "é"];
        let seps = ["\\", "\\", "/", "\\\\", "/\\"];
        let mut rng = super::pathops::Rng(0x0f11_7a7e_5eed_0001);
        let mut inputs: Vec<String> = curated.iter().map(|s| s.to_string()).collect();
        for _ in 0..1200 {
            let mut s = rng.pick(&prefixes).to_string();
            let parts = rng.below(5);
            for i in 0..parts {
                if i > 0 {
                    s.push_str(rng.pick(&seps));
                }
                s.push_str(rng.pick(&tokens));
            }
            if rng.below(4) == 0 {
                s.push_str(rng.pick(&seps));
            }
            inputs.push(s);
        }
        inputs.iter().map(|p| json!({ "cwd": CWD, "path": p, "out": full_path(p) })).collect()
    }
}

// ---------------------------------------------------------------------------
// verbatim: upstream cli/src/qr.rs
// ---------------------------------------------------------------------------

const PNG_SCALE: usize = 8;
const PNG_QUIET_ZONE: usize = 4;

pub fn render_address_qr_unicode(text: &str) -> Result<String, qrcode::types::QrError> {
    let code = QrCode::new(text.as_bytes())?;
    let rendered = code
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Light)
        .light_color(unicode::Dense1x2::Dark)
        .quiet_zone(true)
        .build();
    Ok(rendered)
}

pub fn render_address_qr_png(text: &str) -> Result<Vec<u8>, qrcode::types::QrError> {
    let code = QrCode::new(text.as_bytes())?;
    let modules = code.width();
    let image_modules = modules + PNG_QUIET_ZONE * 2;
    let size = image_modules * PNG_SCALE;
    let mut raw = Vec::with_capacity((size + 1) * size);

    for y in 0..size {
        raw.push(0); // PNG filter: None
        for x in 0..size {
            let mx = x / PNG_SCALE;
            let my = y / PNG_SCALE;
            let dark = mx >= PNG_QUIET_ZONE
                && mx < PNG_QUIET_ZONE + modules
                && my >= PNG_QUIET_ZONE
                && my < PNG_QUIET_ZONE + modules
                && code[(mx - PNG_QUIET_ZONE, my - PNG_QUIET_ZONE)] != QrColor::Light;
            raw.push(if dark { 0 } else { 255 });
        }
    }

    Ok(encode_grayscale_png(size as u32, size as u32, &raw))
}

fn encode_grayscale_png(width: u32, height: u32, raw_rows: &[u8]) -> Vec<u8> {
    let mut png = Vec::new();
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]); // 8-bit grayscale
    push_png_chunk(&mut png, b"IHDR", &ihdr);
    push_png_chunk(&mut png, b"IDAT", &zlib_store(raw_rows));
    push_png_chunk(&mut png, b"IEND", &[]);
    png
}

fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01]; // zlib header: no compression/fastest
    for (i, chunk) in data.chunks(u16::MAX as usize).enumerate() {
        let final_block = i == data.len().saturating_sub(1) / (u16::MAX as usize);
        out.push(if final_block { 0x01 } else { 0x00 });
        let len = chunk.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn push_png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_data = Vec::with_capacity(kind.len() + data.len());
    crc_data.extend_from_slice(kind);
    crc_data.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_data).to_be_bytes());
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65_521;
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in data {
        a = (a + byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QrDisplayMode {
    TerminalUnicode,
    ImageNotify,
}

impl QrDisplayMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::TerminalUnicode => "terminal-unicode",
            Self::ImageNotify => "image-notify",
        }
    }
}

fn display_mode_from_codex_session_line(line: &str) -> Option<QrDisplayMode> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let meta = value
        .get("session_meta")
        .or_else(|| value.get("payload"))
        .unwrap_or(&value);
    display_mode_from_codex_meta(
        find_json_string(meta, "originator"),
        find_json_string(meta, "source"),
    )
}

fn display_mode_from_codex_meta(
    originator: Option<&str>,
    source: Option<&str>,
) -> Option<QrDisplayMode> {
    let originator = originator.map(normalize_codex_meta_value);
    let source = source.map(normalize_codex_meta_value);
    match originator.as_deref() {
        Some("codex-tui") | Some("codex_exec") => Some(QrDisplayMode::TerminalUnicode),
        Some("codex desktop") => Some(QrDisplayMode::ImageNotify),
        _ => match source.as_deref() {
            Some("cli") | Some("exec") => Some(QrDisplayMode::TerminalUnicode),
            Some("vscode") | Some("appserver") => Some(QrDisplayMode::ImageNotify),
            _ => None,
        },
    }
}

fn normalize_codex_meta_value(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn find_json_string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    match value {
        serde_json::Value::Object(map) => map
            .get(key)
            .and_then(|value| value.as_str())
            .or_else(|| map.values().find_map(|value| find_json_string(value, key))),
        serde_json::Value::Array(values) => {
            values.iter().find_map(|value| find_json_string(value, key))
        }
        _ => None,
    }
}

/// upstream `markdown_image_for_path`, with `std::env::current_dir().ok()`
/// replaced by the explicit `cwd` argument (the only change).
fn markdown_image_for_path_in(path: &Path, cwd: Option<PathBuf>) -> String {
    let target = if path.is_absolute() {
        cwd.and_then(|cwd| {
            path.strip_prefix(cwd)
                .ok()
                .map(|rel| PathBuf::from(".").join(rel))
        })
        .unwrap_or_else(|| path.to_path_buf())
    } else {
        PathBuf::from(".").join(path)
    };
    format!(
        "![QR Code](<{}>)",
        target.to_string_lossy().replace('>', "%3E")
    )
}

// ---------------------------------------------------------------------------
// Same code over raw bytes (non-UTF-8 inputs).
// ---------------------------------------------------------------------------

fn render_unicode_bytes(data: &[u8]) -> Result<String, qrcode::types::QrError> {
    let code = QrCode::new(data)?;
    Ok(code
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Light)
        .light_color(unicode::Dense1x2::Dark)
        .quiet_zone(true)
        .build())
}

fn render_png_bytes(data: &[u8]) -> Result<Vec<u8>, qrcode::types::QrError> {
    let code = QrCode::new(data)?;
    let modules = code.width();
    let image_modules = modules + PNG_QUIET_ZONE * 2;
    let size = image_modules * PNG_SCALE;
    let mut raw = Vec::with_capacity((size + 1) * size);
    for y in 0..size {
        raw.push(0);
        for x in 0..size {
            let mx = x / PNG_SCALE;
            let my = y / PNG_SCALE;
            let dark = mx >= PNG_QUIET_ZONE
                && mx < PNG_QUIET_ZONE + modules
                && my >= PNG_QUIET_ZONE
                && my < PNG_QUIET_ZONE + modules
                && code[(mx - PNG_QUIET_ZONE, my - PNG_QUIET_ZONE)] != QrColor::Light;
            raw.push(if dark { 0 } else { 255 });
        }
    }
    Ok(encode_grayscale_png(size as u32, size as u32, &raw))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

/// Row-major module bits (1 = dark), MSB first, hex.
fn modules_hex(code: &QrCode) -> String {
    let colors = code.to_colors();
    let mut bytes = vec![0u8; (colors.len() + 7) / 8];
    for (i, c) in colors.iter().enumerate() {
        if *c != QrColor::Light {
            bytes[i / 8] |= 0x80 >> (i % 8);
        }
    }
    hex(&bytes)
}

fn version_num(v: Version) -> i16 {
    match v {
        Version::Normal(n) => n,
        Version::Micro(n) => -n,
    }
}

/// Input as JSON: `input` (UTF-8) or `inputHex`; a long trailing run of one
/// byte is emitted as `repeat: [byte, count]` (input = prefix + byte × count).
fn input_fields(data: &[u8], obj: &mut serde_json::Map<String, Value>) {
    let mut run = 0;
    if let Some(&last) = data.last() {
        run = data.iter().rev().take_while(|b| **b == last).count();
    }
    let (prefix, repeat) = if run > 64 { (&data[..data.len() - run], Some((data[data.len() - 1], run))) } else { (data, None) };
    match std::str::from_utf8(prefix) {
        Ok(s) => obj.insert("input".into(), Value::String(s.to_string())),
        Err(_) => obj.insert("inputHex".into(), Value::String(hex(prefix))),
    };
    if let Some((b, n)) = repeat {
        obj.insert("repeat".into(), json!([b, n]));
    }
}

/// One QR vector. `full` adds the module matrix and the full unicode block.
fn qr_vector(name: &str, data: &[u8], full: bool) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("name".into(), json!(name));
    input_fields(data, &mut obj);
    match QrCode::new(data) {
        Err(e) => {
            obj.insert("error".into(), json!(e.to_string()));
            // The upstream &str entry points must fail the same way.
            if let Ok(s) = std::str::from_utf8(data) {
                assert_eq!(render_address_qr_unicode(s).unwrap_err(), e);
                assert_eq!(render_address_qr_png(s).unwrap_err(), e);
            }
        }
        Ok(code) => {
            let unicode = render_unicode_bytes(data).unwrap();
            let png = render_png_bytes(data).unwrap();
            if let Ok(s) = std::str::from_utf8(data) {
                assert_eq!(render_address_qr_unicode(s).unwrap(), unicode);
                assert_eq!(render_address_qr_png(s).unwrap(), png);
            }
            obj.insert("version".into(), json!(version_num(code.version())));
            obj.insert("width".into(), json!(code.width()));
            obj.insert("unicodeSha256".into(), json!(sha256_hex(unicode.as_bytes())));
            obj.insert("pngLen".into(), json!(png.len()));
            obj.insert("pngSha256".into(), json!(sha256_hex(&png)));
            if full {
                obj.insert("modules".into(), json!(modules_hex(&code)));
                obj.insert("unicode".into(), json!(unicode));
            } else {
                obj.insert("modulesSha256".into(), json!(sha256_hex(modules_hex(&code).as_bytes())));
            }
        }
    }
    Value::Object(obj)
}

/// xorshift64* — deterministic fuzz inputs.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick(&mut self, alphabet: &[u8], len: usize) -> Vec<u8> {
        (0..len).map(|_| alphabet[self.below(alphabet.len())]).collect()
    }
}

fn version_of(data: &[u8]) -> Option<i16> {
    QrCode::new(data).ok().map(|c| version_num(c.version()))
}

/// Lengths around every version change of `unit` repeated (and the first
/// overflow), found by binary search on the monotone version function.
fn boundary_lengths(unit: u8, max: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let data = vec![unit; max];
    let mut prev = version_of(&data[..0]);
    let mut n = 1;
    while n <= max {
        // find the next length whose version differs from `prev`
        let (mut lo, mut hi) = (n, max + 1);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if version_of(&data[..mid]) == prev { lo = mid + 1 } else { hi = mid }
        }
        if lo > max {
            break;
        }
        out.push(lo - 1);
        out.push(lo);
        prev = version_of(&data[..lo]);
        if prev.is_none() {
            break;
        }
        n = lo + 1;
    }
    out
}

fn main() {
    // Absolute: the GetFullPathNameW vectors pin the process cwd later on.
    let out_path = std::path::absolute(std::env::args().nth(1).unwrap_or_else(|| "vectors.json".to_string()))
        .expect("output path")
        .display()
        .to_string();
    let mut qr = Vec::new();

    // Named inputs: the addresses and payloads onchainos renders, plus classic vectors.
    let long_url = format!(
        "https://web3.okx.com/portfolio/receive?chain=ethereum&address={}&amount=1.5&token=USDC&memo={}",
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
        "x".repeat(120)
    );
    let url_1000 = format!("https://web3.okx.com/pay?data={}", "ab12CD/".repeat(140));
    let named: Vec<(&str, Vec<u8>)> = vec![
        ("evm-sample", b"0x1234567890abcdef1234567890abcdef12345678".to_vec()),
        ("evm-checksum", b"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed".to_vec()),
        ("evm-scheme", b"ethereum:0x1234567890abcdef1234567890abcdef12345678".to_vec()),
        ("evm-upper-hex", b"0X5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED".to_vec()),
        ("solana", b"7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV".to_vec()),
        ("solana-wsol", b"So11111111111111111111111111111111111111112".to_vec()),
        ("btc-bech32", b"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".to_vec()),
        ("btc-bech32-upper", b"BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ".to_vec()),
        ("btc-taproot", b"bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297".to_vec()),
        ("btc-legacy", b"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa".to_vec()),
        ("tron", b"TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7".to_vec()),
        ("sui-64hex", b"0x2a6e4f9c1b3d5e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7".to_vec()),
        ("url-short", b"https://web3.okx.com/".to_vec()),
        ("url-long", long_url.into_bytes()),
        ("url-1000", url_1000.into_bytes()),
        ("annex-i-numeric", b"01234567".to_vec()),
        ("numeric-20", b"01234567890123456789".to_vec()),
        ("hello-world", b"HELLO WORLD".to_vec()),
        ("mixed-abc123", b"ABC123abcd".to_vec()),
        ("gs1-like", b"01049123451234591597033130128%10ABC123".to_vec()),
        ("empty", b"".to_vec()),
        ("single-a", b"a".to_vec()),
        ("cjk-utf8", "你好，世界 onchainos 钱包地址".as_bytes().to_vec()),
        ("sjis", b"\x82\xa0\x81\x41\x41\xb1\x81\xf0".to_vec()),
        ("sjis-not-kanji", b"\x81\x30\xeb\xc0\x81\x7f\x81\x40\x81".to_vec()),
        ("all-bytes", (0u8..=255).collect()),
        ("byte-max-v40", vec![b'a'; 2331]),
        ("byte-over-v40", vec![b'a'; 2332]),
        ("over-8000", format!("0x{}", "a".repeat(8000)).into_bytes()),
    ];
    for (name, data) in &named {
        let full = data.len() <= 300;
        qr.push(qr_vector(name, data, full));
    }

    // Version boundaries for each pure mode (byte, alphanumeric, numeric).
    for (tag, unit, max) in [("byte", b'x', 2400usize), ("alnum", b'Z', 3500), ("numeric", b'7', 5700)] {
        for len in boundary_lengths(unit, max) {
            qr.push(qr_vector(&format!("boundary-{tag}-{len}"), &vec![unit; len], false));
        }
    }

    // Deterministic fuzz across alphabets that stress the segment optimiser.
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let hex_lower = b"0123456789abcdef";
    let b58 = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let bech = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let alnum = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
    let url = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&'()*+,;=%";
    let digits = b"0123456789";
    let mixed = b"0123456789000000ABCDEFXYZ::::abc";
    let kanji_hi = [0x81u8, 0x88, 0x9f, 0xe0, 0xe5, 0xea, 0xeb];
    let kanji_lo = [0x40u8, 0x41, 0x5a, 0x7e, 0x80, 0x9f, 0xa0, 0xbf, 0xc0, 0xdf, 0xec, 0xfc, 0x30, 0x20, 0xff];
    for i in 0..320usize {
        let kind = i % 10;
        let big = (i / 10) % 8 == 7;
        let data: Vec<u8> = match kind {
            0 => { let mut d = b"0x".to_vec(); d.extend(rng.pick(hex_lower, 40)); d }
            1 => { let n = 32 + rng.below(13); rng.pick(b58, n) }
            2 => { let mut d = b"bc1q".to_vec(); let n = 34 + rng.below(30); d.extend(rng.pick(bech, n)); if rng.below(2) == 0 { d.make_ascii_uppercase(); } d }
            3 => { let n = if big { 1500 + rng.below(1900) } else { 1 + rng.below(200) }; rng.pick(alnum, n) }
            4 => { let n = if big { 1000 + rng.below(1400) } else { 10 + rng.below(300) }; let mut d = b"https://web3.okx.com/".to_vec(); d.extend(rng.pick(url, n)); d }
            5 => { let n = if big { 3000 + rng.below(2700) } else { 1 + rng.below(250) }; rng.pick(digits, n) }
            6 => { let n = if big { 800 + rng.below(1600) } else { 1 + rng.below(220) }; rng.pick(mixed, n) }
            7 => { let n = if big { 600 + rng.below(1800) } else { 1 + rng.below(200) }; (0..n).map(|_| (rng.next() & 0xff) as u8).collect() }
            8 => {
                let n = 1 + rng.below(if big { 900 } else { 120 });
                let mut d = Vec::new();
                for _ in 0..n {
                    match rng.below(4) {
                        0 | 1 => { d.push(kanji_hi[rng.below(kanji_hi.len())]); d.push(kanji_lo[rng.below(kanji_lo.len())]); }
                        2 => d.push(alnum[rng.below(alnum.len())]),
                        _ => d.push((rng.next() & 0xff) as u8),
                    }
                }
                d
            }
            _ => {
                // segments of different modes concatenated
                let mut d = Vec::new();
                let parts = 1 + rng.below(if big { 60 } else { 8 });
                for _ in 0..parts {
                    let n = 1 + rng.below(30);
                    let alpha: &[u8] = match rng.below(4) { 0 => digits, 1 => alnum, 2 => url, _ => b"\x82\xa0\x81\x41" };
                    d.extend(rng.pick(alpha, n));
                }
                d
            }
        };
        qr.push(qr_vector(&format!("fuzz-{i}"), &data, false));
    }

    // PNG building blocks.
    let mut checks = Vec::new();
    for len in [0usize, 1, 3, 13, 65534, 65535, 65536, 131070, 131071, 200000] {
        let data: Vec<u8> = (0..len).map(|i| (i * 31 + 7) as u8).collect();
        checks.push(json!({
            "len": len,
            "crc32": crc32(&data),
            "adler32": adler32(&data),
            "zlibSha256": sha256_hex(&zlib_store(&data)),
            "zlibLen": zlib_store(&data).len(),
        }));
    }
    let tiny = encode_grayscale_png(2, 1, &[0, 0, 255]);

    // Codex session first lines → display mode.
    let lines = [
        r#"{"type":"session_meta","payload":{"originator":"codex-tui","source":"cli"}}"#.to_string(),
        r#"{"type":"session_meta","payload":{"originator":"Codex Desktop","source":"vscode"}}"#.to_string(),
        r#"{"type":"session_meta","payload":{"originator":"Codex Desktop","source":"appServer"}}"#.to_string(),
        r#"{"type":"session_meta","payload":{"originator":"codex_exec","source":"exec"}}"#.to_string(),
        "not json\n".to_string(),
        "".to_string(),
        "{\"payload\":{\"originator\":\"codex-tui\"}}\r\n".to_string(),
        r#"{"payload":{"originator":5,"x":{"originator":"codex_exec"}}}"#.to_string(),
        r#"{"session_meta":null,"payload":{"originator":"codex-tui"}}"#.to_string(),
        r#"{"b":{"source":"vscode"},"a":{"source":"cli"}}"#.to_string(),
        r#"{"b":{"source":"cli"},"a":{"source":"vscode"}}"#.to_string(),
        r#"{"Z":{"originator":"codex-tui"},"_":{"originator":"codex desktop"}}"#.to_string(),
        r#"[{"originator":"codex desktop"}]"#.to_string(),
        r#"{"originator":" CODEX-TUI\u00a0"}"#.to_string(),
        r#"{"originator":"\ufeffcodex-tui"}"#.to_string(),
        r#"{"originator":"codex-tui\u0085"}"#.to_string(),
        r#"{"originator":"codex-tui\u200b"}"#.to_string(),
        r#"{"originator":"\u3000codex-tui\u2029"}"#.to_string(),
        r#"{"originator":"unknown","source":"exec"}"#.to_string(),
        r#"{"source":"appserver"}"#.to_string(),
        r#"{"originator":"Codex Desktop","source":"cli"}"#.to_string(),
        r#"{"payload":"str","originator":"codex-tui"}"#.to_string(),
        r#"{"session_meta":{"source":"exec"},"payload":{"source":"vscode"}}"#.to_string(),
        r#"{"originator":"CODEX-TUİ"}"#.to_string(),
        r#"{"originator":"CODEX-TUI"}"#.to_string(),
        r#"{"source":"\ud800"}"#.to_string(),
        r#"{"source":"cli","k\udc00":1}"#.to_string(),
        r#"{"source":"cli","e":"\ud83d\ude00"}"#.to_string(),
        r#"{"source":"cli","n":1e400}"#.to_string(),
        r#"{"source":"cli","n":-1e400}"#.to_string(),
        r#"{"source":"cli","n":1e308}"#.to_string(),
        r#"{"source":"cli","n":123456789012345678901234567890}"#.to_string(),
        r#"{"source":"cli"} trailing"#.to_string(),
        "{\"source\":\"cli\"}\u{feff}".to_string(),
        "\u{feff}{\"source\":\"cli\"}".to_string(),
        r#"{"source":"cli","source":"vscode"}"#.to_string(),
        r#"{"source":"vscode","source":"cli"}"#.to_string(),
        r#"{"source":"cli","x":"a\u0000b"}"#.to_string(),
        "{\"source\":\"cli\",\"x\":\"tab\there\"}".to_string(),
        r#"{"source":"cli","x":[1,2,]}"#.to_string(),
        format!("{}{{\"source\":\"cli\"}}{}", "[".repeat(126), "]".repeat(126)),
        format!("{}{{\"source\":\"cli\"}}{}", "[".repeat(127), "]".repeat(127)),
        format!("{}{{\"source\":\"cli\"}}{}", "[".repeat(128), "]".repeat(128)),
        format!("{}\"x\"{}", "[".repeat(128), "]".repeat(128)),
        format!("{}\"x\"{}", "[".repeat(129), "]".repeat(129)),
    ];
    let codex_lines: Vec<Value> = lines
        .iter()
        .map(|line| json!({ "line": line, "mode": display_mode_from_codex_session_line(line).map(|m| m.as_str()) }))
        .collect();

    // Path semantics used for image paths / markdown (platform-specific).
    let platform = if cfg!(windows) { "windows" } else { "unix" };
    let join_bases: &[&str] = if cfg!(windows) {
        &["C:", "c:", "C:\\", "C:\\a", "C:\\a\\", "C:/a", "C:/a/", "", "rel", "rel\\", "rel/", "\\\\server\\share", "\\\\server\\share\\", "\\a", "/a", "C:a"]
    } else {
        &["", "/", "/a", "/a/", "rel", "rel/", "/a//b"]
    };
    let joins: Vec<Value> = join_bases
        .iter()
        .flat_map(|base| {
            ["tmp", "onchainos-funding-qr-1-2.png"].iter().map(move |part| {
                json!({ "base": base, "part": part, "out": PathBuf::from(base).join(part).display().to_string() })
            })
        })
        .collect();
    let (cwds, paths): (Vec<Option<&str>>, Vec<&str>) = if cfg!(windows) {
        (
            vec![Some("D:\\Job\\x"), Some("D:\\Job\\x\\"), Some("d:/Job/x"), Some("\\\\?\\D:\\Job\\x"), Some("\\\\srv\\sh\\x"), None],
            vec![
                "D:\\Job\\x\\.onchainos\\tmp\\funding-qr\\f.png",
                "d:\\Job\\x\\a\\f.png",
                "D:/Job/x/a/f.png",
                "D:\\Job\\xy\\f.png",
                "D:\\Job\\X\\f.png",
                "E:\\f.png",
                "rel\\f.png",
                "f.png",
                "D:\\Job\\x\\a>b\\f>.png",
                "D:\\Job\\x\\\\a\\f.png",
                "D:\\Job\\x\\.\\a\\f.png",
                "D:\\Job\\x\\..\\x\\f.png",
                "\\\\srv\\sh\\x\\f.png",
                "\\\\SRV\\sh\\x\\f.png",
                "\\\\?\\D:\\Job\\x\\f.png",
                "D:f.png",
                "\\Job\\x\\f.png",
                "D:\\Job\\x",
            ],
        )
    } else {
        (
            vec![Some("/home/u/w"), Some("/home/u/w/"), Some("/"), None],
            vec![
                "/home/u/w/.onchainos/tmp/funding-qr/f.png",
                "/home/u/w/a/f.png",
                "/home/u/wx/f.png",
                "/home/u/W/f.png",
                "/tmp/f.png",
                "rel/f.png",
                "f.png",
                "/home/u/w/a>b/f>.png",
                "/home/u/w//a/f.png",
                "/home/u/w/./a/f.png",
                "/home/u/w/../w/f.png",
                "/home/u/w",
            ],
        )
    };
    let mut markdown = Vec::new();
    for cwd in &cwds {
        for p in &paths {
            markdown.push(json!({
                "cwd": cwd,
                "path": p,
                "out": markdown_image_for_path_in(Path::new(p), cwd.map(PathBuf::from)),
            }));
        }
    }

    // std::path (Windows flavour) and GetFullPathNameW vectors; the Unix flavour comes
    // from the wasm32 build in unix-paths/ (gen-unix-paths.mjs).
    #[cfg(windows)]
    let (path_ops_win, full_path) = (pathops::vectors(true), Value::Array(win::full_path_vectors()));
    #[cfg(not(windows))]
    let (path_ops_win, full_path) = (json!({ "paths": [], "pairs": [] }), json!([]));

    let doc = json!({
        "generator": "test/oracle-qr (qrcode 0.14.1, upstream cli/src/qr.rs 4.6.3)",
        "qr": qr,
        "png": { "blocks": checks, "tinySha256": sha256_hex(&tiny), "tinyHex": hex(&tiny) },
        "codexLines": codex_lines,
        "paths": { "platform": platform, "join": joins, "markdown": markdown },
        "pathOpsWinPaths": path_ops_win["paths"],
        "pathOpsWinPairs": path_ops_win["pairs"],
        "fullPath": full_path,
    });
    let mut text = String::from("{\n");
    let obj = doc.as_object().unwrap();
    let keys: Vec<&String> = obj.keys().collect();
    for (i, k) in keys.iter().enumerate() {
        text.push_str(&format!("  {}: ", serde_json::to_string(k).unwrap()));
        match &obj[*k] {
            Value::Array(items) => {
                text.push_str("[\n");
                for (j, item) in items.iter().enumerate() {
                    text.push_str("    ");
                    text.push_str(&serde_json::to_string(item).unwrap());
                    if j + 1 < items.len() { text.push(','); }
                    text.push('\n');
                }
                text.push_str("  ]");
            }
            other => text.push_str(&serde_json::to_string(other).unwrap()),
        }
        if i + 1 < keys.len() { text.push(','); }
        text.push('\n');
    }
    text.push_str("}\n");
    std::fs::write(&out_path, text).expect("write vectors");
    eprintln!("wrote {} ({} qr vectors)", out_path, obj["qr"].as_array().unwrap().len());
}
