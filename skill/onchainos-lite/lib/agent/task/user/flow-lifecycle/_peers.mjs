// PRIVATE lazy imports from the user-lifecycle partition of its task/user siblings
// (task/user/{create,negotiate,content,attachments,device_routing,reject_apply,accept}.rs,
// task/user/flow_negotiate/*). The imports are dynamic because several of those modules import
// this partition back (create → v2/create-and-fund, negotiate playbooks → flow); resolving them
// on first use keeps the module graph acyclic at evaluation time. No logic lives here.

const peer = (rel) => import(new URL(rel, import.meta.url).href);

// upstream: task/user/content.rs (the whole template module)
let CONTENT;
export async function content() {
  CONTENT ??= await peer('../content.mjs');
  return CONTENT;
}

// upstream: create.rs::resolve_user_agent → [agentId, ownerAddress]
export async function resolveUserAgent() {
  return (await peer('../create.mjs')).resolveUserAgent();
}

// upstream: negotiate.rs::cleanup
export async function negotiateCleanup(jobId) {
  return (await peer('../negotiate.mjs')).cleanup(jobId);
}
// upstream: negotiate.rs::get_designated_provider — callers use `.ok().flatten()`, so errors
// and empty values both read as "no designated provider".
export async function getDesignatedProvider(jobId) {
  const m = await peer('../negotiate.mjs');
  try { return (await m.getDesignatedProvider(jobId)) ?? undefined; } catch { return undefined; }
}
// upstream: negotiate.rs::save_designated_provider
export async function saveDesignatedProvider(jobId, providerAgentId) {
  return (await peer('../negotiate.mjs')).saveDesignatedProvider(jobId, providerAgentId);
}

// upstream: attachments.rs::list_attachment_paths
export async function listAttachmentPaths(jobId) {
  return (await peer('../attachments.mjs')).listAttachmentPaths(jobId);
}
// upstream: attachments.rs::copy_attachments_to_job_with_manifest
export async function copyAttachmentsToJobWithManifest(jobId, sources) {
  return (await peer('../attachments.mjs')).copyAttachmentsToJobWithManifest(jobId, sources);
}

// upstream: reject_apply.rs::handle_reject_apply (prints two lines on success)
export async function handleRejectApply(client, jobId, explicitAgentId) {
  return (await peer('../reject-apply.mjs')).handleRejectApply(client, jobId, explicitAgentId);
}

// upstream: accept.rs::handle_confirm_accept (FUNDS)
export async function handleConfirmAccept(client, jobId, prefetched) {
  return (await peer('../accept.mjs')).handleConfirmAccept(client, jobId, prefetched);
}

// upstream: task/user/flow_negotiate/mod.rs
export async function flowNegotiate() {
  return peer('../flow-negotiate/index.mjs');
}

// upstream: device_routing.rs::fetch_device_list_snapshot
export async function fetchDeviceListSnapshot(client, agentId, page, pageSize) {
  return (await peer('../device-routing.mjs')).fetchDeviceListSnapshot(client, agentId, page, pageSize);
}
