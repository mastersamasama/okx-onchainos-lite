// workflow — upstream cli/src/commands/workflows/mod.rs. The per-workflow handlers live in the
// sibling files (token-research, smart-money, new-tokens, wallet-analysis, portfolio), each
// mirroring its upstream module; this file holds the shared helper.

// upstream: workflows/mod.rs::ok_or_null — Ok(v) → v, Err → JSON null (error swallowed, nothing
// printed). `r` is the pending Result: a promise, or a thunk (so a synchronous throw while
// building the request is swallowed too, as an Err would be).
export async function okOrNull(r) {
  try {
    const v = await (typeof r === 'function' ? r() : r);
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

export default {};
