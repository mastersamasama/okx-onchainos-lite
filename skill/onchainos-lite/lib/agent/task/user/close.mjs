// Disabled legacy close command — upstream task/user/close.rs.
// Closing a funded V2 task is a refund-related funds mutation and must use Refund V2
// (refund-prepare → confirmed refund-execute) instead of this context-free entry point.

// upstream: close.rs::handle_close
export async function handleClose(_client, jobId, _explicitAgentId) {
  throw new Error(`direct close is disabled for V2 tasks; run \`onchainos agent refund-prepare ${jobId}\` and execute only the returned confirmed action`);
}
