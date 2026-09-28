//! wasm32-unknown-unknown build of ../src/pathops.rs: std picks sys/path/unix.rs for
//! this target ('/' only, no prefixes), i.e. the path semantics upstream has on
//! Linux/macOS. `Path::is_absolute` is the one exception (it needs cfg(unix) and is
//! always false here), so Unix consumers use `hasRoot`, which is what is_absolute
//! returns on Unix. Driven by ../gen-unix-paths.mjs.

#[path = "../src/pathops.rs"]
mod pathops;

use std::sync::atomic::{AtomicUsize, Ordering};

static OUT_LEN: AtomicUsize = AtomicUsize::new(0);

/// Serialises the unix vectors into a leaked buffer; returns its address (length via `out_len`).
#[no_mangle]
pub extern "C" fn generate() -> *const u8 {
    let text = serde_json::to_string(&pathops::vectors(false)).expect("json");
    let bytes = text.into_bytes().into_boxed_slice();
    OUT_LEN.store(bytes.len(), Ordering::SeqCst);
    Box::into_raw(bytes) as *const u8
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    OUT_LEN.load(Ordering::SeqCst)
}
