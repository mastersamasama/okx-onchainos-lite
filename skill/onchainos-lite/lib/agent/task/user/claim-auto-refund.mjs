// Disabled legacy timeout auto-refund command — upstream task/user/claim_auto_refund.rs.
// Timeout refunds are backend-owned; no code path here performs the mutation.

// upstream: claim_auto_refund.rs::handle_claim_auto_refund
export async function handleClaimAutoRefund(_client, jobId) {
  throw new Error(`direct claim-auto-refund is disabled by Refund because timeout refunds are backend-owned; use \`onchainos agent refund-prepare ${jobId}\` only to read the authoritative current state. Expired(8) is terminal and confirms any applicable automatic refund`);
}
