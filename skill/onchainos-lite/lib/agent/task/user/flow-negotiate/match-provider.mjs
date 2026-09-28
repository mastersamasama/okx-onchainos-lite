// `job_created` playbook — upstream task/user/flow_negotiate/match_provider.rs.
// ctx = FlowContext { jobId, agentId, shortId, titleDisplay, paymentMode, prefetched, … }.
import { stringify } from '../../../../core/json.mjs';
import { designatedRouteInner } from '../../common/index.mjs';
import { get, asStr } from '../../../_rs.mjs';
import { getDesignatedProvider } from '../negotiate.mjs';
import { jobCreatedDesignatedUserNotify } from '../content.mjs';
import { branchA2aCli, branchError } from './designated.mjs';

const designated = (jobId) => { try { return getDesignatedProvider(jobId); } catch { return undefined; } };

// upstream: match_provider.rs::job_created
export async function jobCreated(ctx) {
  if (designated(ctx.jobId) === undefined) return jobCreatedNoDesignatedProvider(ctx);
  return jobCreatedWithDesignatedProvider(ctx);
}

// upstream: match_provider.rs::job_created_no_designated_provider (private)
function jobCreatedNoDesignatedProvider(ctx) {
  const title = ctx.titleDisplay, shortId = ctx.shortId;
  return '[Trigger] job_created (on-chain, no designated provider recorded locally)\n[Role] User (User)\n\n'
    + `🛑 Notify the user the job 「${title}」 (${shortId}) is confirmed on-chain, then end the turn. Designate a provider with \`onchainos agent set-asp\` if one is not already attached.\n\n`
    + "**Action — Notify the user.** **Localize first** — rewrite the content below in the user's language before sending.\n"
    + '```bash\nonchainos agent user-notify --content "<localized content>"\n```\n'
    + `Content: [Job Created]「${title}」(${shortId}) confirmed on-chain.\n\n`
    + '🛑 End the turn after notifying.\n';
}

// upstream: match_provider.rs::job_created_with_designated_provider (private)
async function jobCreatedWithDesignatedProvider(ctx) {
  const { jobId, agentId, shortId } = ctx;
  const dpId = designated(jobId);
  const notifyFilled = jobCreatedDesignatedUserNotify().split('<title>').join(ctx.titleDisplay).split('<short_jobId>').join(shortId).split('<provider_agentId>').join(dpId);
  const notifyBody = "**Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n"
    + `Content:\n  ${notifyFilled}\n`
    + '```bash\nonchainos agent user-notify --content "<localized content shown below>"\n```\n\n';
  const serviceId = ctx.prefetched?.serviceId ?? undefined;
  let routeJson;
  try { routeJson = await designatedRouteInner(dpId, serviceId); } catch (e) { return `[job_created_cli] ERROR: designated-route failed: ${e.message}\n`; }
  const route = asStr(get(routeJson, 'route')) ?? '';
  let playbook;
  if (route === 'a2a') playbook = await branchA2aCli(jobId, agentId, dpId);
  else if (route === 'error') playbook = branchError(jobId, agentId, shortId, dpId);
  else return `[job_created_cli] ERROR: unknown route value '${route}' in designated-route response: ${stringify(routeJson)}\n`;
  if (playbook !== undefined) return `**Action 0 — Notify the user the job is on-chain.** ${notifyBody}After Action 0 completes, follow the branch-specific playbook below:\n\n---\n\n${playbook}`;
  return notifyBody;
}
