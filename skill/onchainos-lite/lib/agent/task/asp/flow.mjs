// ASP-side task flow driver — upstream task/asp/flow.rs (`generate_next_action`, consumed by
// `agent next-action --role asp`). Every playbook literal is a byte-exact port of the Rust
// format string (placeholders → `${v.<rust_name>}`).
import { renameSync, copyFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { stringify } from '../../../core/json.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { get, asStr, asI64, isObject, cloneValue } from '../../../core/rs/value.mjs';
import { trim } from '../../../core/rs/str.mjs';
import { ioErrorText, fileName } from '../../../core/rs/fs.mjs';
import { shortJobId } from '../common/util.mjs';
import { parseStatusOrEvent, Event } from '../common/state-machine.mjs';
import { findService } from '../common/index.mjs';
import { requestCommandBlock, encodeRefundDecisionVars } from '../common/pending-v2.mjs';
import { REFUND_SERVICE_NAME_PLACEHOLDER } from '../common/template-vars.mjs';
import { fileDownload } from '../common/okx-a2a.mjs';
import {
  JOB_REJECTED, SUB_USER_REJECT, buildDecisionResult, scalarString, blockedResult, isDecisionSource, resolvedAction, buildSelectedResult,
  defaultChoices, choicesJson,
} from '../arbitration.mjs';
import * as content from './content.mjs';
import * as notification from './v2/notification.mjs';
import * as jobCompleted from './v2/job-completed.mjs';
import * as subCompleteNotify from './v2/sub-complete-notify.mjs';
import { attachmentsDir, dedupDest } from '../user/attachments.mjs';
import { isZeroDecimal } from '../user/refund.mjs';

// upstream: flow.rs::ProviderAssignmentType
const ProviderAssignmentType = Object.freeze({ Single: 'Single', Subscription: 'Subscription' });

// upstream: flow.rs::PROVIDER_ASSIGNMENT_OWNERSHIP_RULE
const PROVIDER_ASSIGNMENT_OWNERSHIP_RULE = 'This provider decision is already delegated to the ASP runtime. Make and execute the decision in this job session without asking the ASP owner or any user for confirmation.';

const has = (v) => v !== undefined && v !== null;
const nonEmpty = (s) => (has(s) && s !== '' ? s : undefined);
const is = (v, n) => has(v) && Number(v) === n && typeof v === 'number';

// upstream: flow.rs::task_params_request_command
export function taskParamsRequestCommand(jobId, buyerAgentId, taskType) {
  const v = { job_id: jobId, buyer_agent_id: buyerAgentId, task_type: taskType };
  return `okx-a2a xmtp-send --job-id ${v.job_id} --to-agent-id ${v.buyer_agent_id} --message "<natural-language request>\\n\\n[intent:task_params_request]\\n{\\"version\\":1,\\"jobId\\":\\"${v.job_id}\\",\\"taskType\\":\\"${v.task_type}\\",\\"requestId\\":\\"<unique-request-id>\\",\\"round\\":<1-3>,\\"missing\\":[\\"<field>\\"]}" --json`;
}

// upstream: flow.rs::provider_assignment_decision_rules → [decisionRule, missingInputRule]
function providerAssignmentDecisionRules(assignmentType, jobId, agentId, buyerAgentId) {
  if (assignmentType === ProviderAssignmentType.Single) {
    const v = { job_id: jobId, agent_id: agentId, buyer_agent_id: buyerAgentId, _0: taskParamsRequestCommand(jobId, buyerAgentId, 'single') };
    return [
      'Output exactly one internal conclusion: `ACCEPT`, `NEED_PARAMS`, or `REJECT`. Do not invent a fourth result.',
      `**NEED_PARAMS** — send one natural-language question followed by the structured block below to the Buyer through peer transport:\n`
        + `\`\`\`bash\n`
        + `${v._0}\n`
        + `\`\`\`\n`
        + `Count only a response for which the buyer successfully updated the backend as a successful round. Ignore duplicate requestId/response messages. Maximum: 3 successful update/response rounds. After the third successful update, fetch current detail and evaluate once more; if still NEED_PARAMS, decline.\n`
        + `\n`
        + `When \`[intent:task_params_response]\` arrives: fetch latest detail again. If status is not CREATED, stop. If CREATED, evaluate the updated complete serviceParams again. The buyer-side required ordering is:\n`
        + `\`\`\`bash\n`
        + `onchainos agent service-param-update ${v.job_id} --agent-id ${v.buyer_agent_id} --task-type single --request-id '<request-id>' --round <same-round> --service-params '<complete JSON>'\n`
        + `# only after exit 0 and backendUpdated=true:\n`
        + `okx-a2a session send --job-id ${v.job_id} --to-agent-id ${v.agent_id} --content "[intent:task_params_response]\\n{\\"version\\":1,\\"jobId\\":\\"${v.job_id}\\",\\"requestId\\":\\"<request-id>\\",\\"round\\":<same-round>,\\"backendUpdated\\":true}" --json\n`
        + `\`\`\`\n`,
    ];
  }
  return [
    'Output exactly one internal conclusion: `ACCEPT` or `REJECT`. `NEED_PARAMS` is forbidden for subscriptions; do not ask the Buyer for parameters. Missing or empty serviceParams is valid and is never a rejection reason. copyTrade, Guide Consent, leverage, margin mode, trade amount, target currency, close strategy, credentials, and every other execution setting are Buyer-local state that the ASP must not inspect, reconstruct, request, or use as a rejection reason. Choose `REJECT` only for a concrete mismatch between the requested subscription and the registered Service capability; otherwise choose `ACCEPT`.',
    'Do not enter task-parameter clarification and do not call `service-param-update` for a subscription.\n',
  ];
}

// upstream: flow.rs::provider_assignment_inputs
function providerAssignmentInputs(assignmentType, description, serviceParams, serviceName, serviceId, serviceDescription) {
  const v = { description, service_name: serviceName, service_id: serviceId, service_description: serviceDescription, _0: serviceParams ?? '{}' };
  if (assignmentType === ProviderAssignmentType.Single) {
    return `Evaluate ONCE using only these four inputs:\n`
      + `- task description: ${v.description}\n`
      + `- serviceParams: ${v._0}\n`
      + `- attachments: inspect the attachments already forwarded into this job session\n`
      + `- registered service: ${v.service_name} (\`${v.service_id}\`): ${v.service_description}`;
  }
  return `Evaluate ONCE using only these three inputs:\n`
    + `- subscription description: ${v.description}\n`
    + `- attachments: inspect the attachments already forwarded into this job session\n`
    + `- registered service: ${v.service_name} (\`${v.service_id}\`): ${v.service_description}\n`
    + `Do not inspect or render serviceParams for a subscription.`;
}

// upstream: flow.rs::provider_assignment_playbook
async function providerAssignmentPlaybook(jobId, agentId, assignmentType, prefetched, message) {
  const single = assignmentType === ProviderAssignmentType.Single;
  const v = {
    job_id: jobId, agent_id: agentId,
    task_type: single ? 'single' : 'subscription', accept_type: single ? 203 : 205, event_name: single ? 'job_asp_selected' : 'sub_open',
    accept_command: single ? 'accept-job-by-provider' : 'accept-subscription', decline_command: single ? 'decline-job-by-provider' : 'decline-subscription',
  };
  const p = prefetched;
  if (!has(p)) {
    return `[Current state] ${v.event_name}\n`
      + `[Role] ASP\n`
      + `\n`
      + `Latest task detail could not be fetched. Stop with an error; do NOT accept, decline, or send task_params_request.\n`
      + `jobId=${v.job_id}\n`;
  }
  if (!has(p.status)) {
    return `[Current state] ${v.event_name}\n`
      + `[Role] ASP\n`
      + `\n`
      + `Latest backend detail has no status. Stop with an error; do NOT accept or decline.\n`
      + `jobId=${v.job_id}\n`;
  }
  if (!is(p.status, 0)) {
    if (is(p.status, 1)) {
      return `[Current state] ${v.event_name}\n`
        + `[Role] ASP\n`
        + `\n`
        + `Latest backend status is ACCEPTED/ACTIVE. This is a duplicate trigger: end idempotently.\n`
        + `Do NOT repeat the mutation or broadcast. jobId=${v.job_id}\n`;
    }
    v.status = String(p.status);
    return `[Current state] ${v.event_name}\n`
      + `[Role] ASP\n`
      + `\n`
      + `Latest backend status is ${v.status}, not CREATED(0). End idempotently; do NOT mutate or broadcast.\n`
      + `jobId=${v.job_id}\n`;
  }
  const msgStr = (key) => { const s = has(message) ? asStr(get(message, key)) : undefined; return s !== undefined && s !== '' ? s : undefined; };
  v.service_id = msgStr('serviceId') ?? nonEmpty(p.serviceId) ?? '';
  if (v.service_id === '') {
    return `[Current state] ${v.event_name}\n`
      + `[Role] ASP\n`
      + `\n`
      + `No serviceId is present. Run the v2 decline command (reason is required, ≤512 Unicode characters):\n`
      + `\`\`\`bash\n`
      + `onchainos agent ${v.decline_command} ${v.job_id} --agent-id ${v.agent_id} --reason "designated serviceId is missing"\n`
      + `\`\`\`\n`;
  }
  let service;
  try { service = await findService(agentId, v.service_id); } catch (error) {
    v.error = error?.message ?? String(error);
    return `[Current state] ${v.event_name}\n`
      + `[Role] ASP\n`
      + `\n`
      + `Service lookup failed: ${v.error}\n`
      + `Stop with an error. Do NOT decline: a timeout, malformed response, or temporary service-list failure is not a capability rejection.\n`
      + `jobId=${v.job_id}\n`;
  }
  if (service === undefined) {
    return `[Current state] ${v.event_name}\n`
      + `[Role] ASP\n`
      + `\n`
      + `\`onchainos agent service-list --agent-id ${v.agent_id} --service-id ${v.service_id}\` completed but returned no matching service.\n`
      + `Run exactly:\n`
      + `\`\`\`bash\n`
      + `onchainos agent ${v.decline_command} ${v.job_id} --agent-id ${v.agent_id} --reason "designated service is not registered"\n`
      + `\`\`\`\n`;
  }
  const serviceName = asStr(get(service, 'serviceName')) ?? '';
  const serviceDescription = asStr(get(service, 'serviceDescription')) ?? '';
  const buyerAgentId = p.userAgentId ?? '<buyerAgentId>';
  [v.decision_rule, v.missing_input_rule] = providerAssignmentDecisionRules(assignmentType, jobId, agentId, buyerAgentId);
  v.evaluation_inputs = providerAssignmentInputs(assignmentType, p.description, p.serviceParams, serviceName, v.service_id, serviceDescription);
  v.PROVIDER_ASSIGNMENT_OWNERSHIP_RULE = PROVIDER_ASSIGNMENT_OWNERSHIP_RULE;
  return `[Current state] ${v.event_name}; latest backend status=CREATED(0)\n`
    + `[Role] ASP\n`
    + `\n`
    + `${v.PROVIDER_ASSIGNMENT_OWNERSHIP_RULE}\n`
    + `\n`
    + `${v.evaluation_inputs}\n`
    + `\n`
    + `${v.decision_rule}\n`
    + `\n`
    + `**ACCEPT** — immediately before mutation, rely on the latest detail above (CREATED). Run:\n`
    + `\`\`\`bash\n`
    + `onchainos agent ${v.accept_command} ${v.job_id} --agent-id ${v.agent_id}\n`
    + `\`\`\`\n`
    + `The command calls the documented ${v.task_type} provider-accept endpoint, signs uopData, broadcasts bizType ${v.accept_type}, and requires a full receipt. End the turn; duplicate accepted events must not repeat it.\n`
    + `\n`
    + `**REJECT** — generate one concrete reason (required, ≤512 Unicode characters), then run:\n`
    + `\`\`\`bash\n`
    + `onchainos agent ${v.decline_command} ${v.job_id} --agent-id ${v.agent_id} --reason "<reason>"\n`
    + `\`\`\`\n`
    + `The reason is placed in broadcast bizContext; do not use legacy \`asp-reject\`.\n`
    + `\n`
    + `${v.missing_input_rule}`;
}

// upstream: flow.rs::arbitration_decision_result → result Value (object)
export function arbitrationDecisionResult(sourceEvent, jobId, jobTitle, prefetched, message) {
  const messageField = (keys) => {
    for (const k of keys) { const s = scalarString(has(message) ? get(message, k) : undefined); if (s !== undefined) return s; }
    return undefined;
  };
  const p = has(prefetched) ? prefetched : undefined;
  const name = messageField(['jobTitle', 'title', 'serviceName'])
    ?? (has(jobTitle) && jobTitle !== '' ? jobTitle : undefined)
    ?? (p ? (nonEmpty(p.serviceName) ?? (p.title !== '' ? p.title : undefined)) : undefined);
  const amount = messageField(['tokenAmount', 'serviceTokenAmount'])
    ?? (p ? (nonEmpty(p.serviceTokenAmount) ?? (p.tokenAmount !== '' ? p.tokenAmount : undefined)) : undefined);
  const tokenSymbol = messageField(['tokenSymbol', 'paymentTokenSymbol'])
    ?? (p && p.tokenSymbol !== '' && p.tokenSymbol !== '?' ? p.tokenSymbol : undefined);
  const ctx = has(message) ? cloneValue(message) : {};
  if (isObject(ctx)) {
    if (get(ctx, 'expireTime') === undefined && p && has(p.expireTime)) ctx.expireTime = p.expireTime;
    if (scalarString(get(ctx, 'serviceName')) === undefined && p && has(p.serviceName) && trim(p.serviceName) !== '') ctx.serviceName = p.serviceName;
    if (scalarString(get(ctx, 'refundReason')) === undefined && p && has(p.refundReason) && trim(p.refundReason) !== '') ctx.refundReason = p.refundReason;
    for (const [key, value] of [['subStartTime', p?.periodStartTime], ['subEndTime', p?.periodEndTime]]) {
      if (get(ctx, key) === undefined && has(value)) ctx[key] = value;
    }
  }
  return buildDecisionResult(sourceEvent, jobId, name, amount, tokenSymbol, ctx);
}

// upstream: flow.rs::arbitration_decision_json
export const arbitrationDecisionJson = (sourceEvent, jobId, jobTitle, prefetched, message) => stringify(arbitrationDecisionResult(sourceEvent, jobId, jobTitle, prefetched, message));

// upstream: flow.rs::arbitration_decision_playbook
function arbitrationDecisionPlaybook(sourceEvent, jobId, agentId, jobTitle, prefetched, message) {
  const result = arbitrationDecisionResult(sourceEvent, jobId, jobTitle, prefetched, message);
  if (result.decision !== 'requires_user_input') return stringify(result);
  const payload = result.payload;
  const required = (key) => asStr(get(payload, key));
  const serviceName = required('serviceName'), taskType = required('taskType'), requestedRefund = required('requestedRefund');
  const buyerReason = required('buyerReason'), responseDeadline = required('responseDeadline'), decisionIdValue = required('decisionId');
  const refundDisplayB64 = required('refundDisplayB64');
  if ([serviceName, taskType, requestedRefund, buyerReason, responseDeadline, decisionIdValue, refundDisplayB64].some((x) => x === undefined)) {
    return blockedResult('missing_required_facts', jobId, { sourceEvent });
  }
  const isSubscription = sourceEvent === SUB_USER_REJECT;
  const currentPeriod = isSubscription ? required('currentPeriod') : undefined;
  if (isSubscription && currentPeriod === undefined) return blockedResult('missing_required_facts', jobId, { sourceEvent, missingFields: ['currentPeriod'] });
  const expiresAt = asI64(get(payload, 'responseDeadlineTimestamp'));
  if (expiresAt === undefined) return blockedResult('missing_required_facts', jobId, { sourceEvent, missingFields: ['responseDeadline'] });
  const v = {
    source_event: sourceEvent, job_id: jobId, agent_id: agentId,
    template_vars_b64: encodeRefundDecisionVars(serviceName, jobId, taskType, currentPeriod, requestedRefund, buyerReason, responseDeadline),
    source_template: content.aspRefundDecisionSourceTemplate(isSubscription),
    choices_json: choicesJson(defaultChoices(sourceEvent, jobId)).split("'").join("'\"'\"'"),
    short_id: shortJobId(jobId),
    to_flag: has(prefetched) && nonEmpty(prefetched.userAgentId) !== undefined ? ` --to-agent-id ${prefetched.userAgentId}` : '',
    label_placeholder: REFUND_SERVICE_NAME_PLACEHOLDER,
    decision_id: decisionIdValue, expires_at: String(expiresAt), refund_display_b64: refundDisplayB64,
  };
  return `[Current state] ${v.source_event} (buyer refund request requires the ASP owner's decision)\n`
    + `[Role] ASP\n`
    + `\n`
    + `Render and push Product Template 6.4 exactly once as a single-record field list. The card itself is the refund-or-evaluation confirmation; do not add a third confirmation.\n`
    + `\n`
    + `Localize the complete source template below to the current conversation language before passing it to \`--user-content\`. Translate the title, field labels, explanatory text, and action wording. Preserve every reserved \`{__OKX_...__}\` placeholder byte-for-byte; the CLI replaces those placeholders in-process after shell parsing. Do not expose or decode \`--template-vars-b64\`.\n`
    + `\n`
    + `\`\`\`bash\n`
    + `onchainos agent pending-decisions-v2 request-prompt \\\n`
    + `  --job-id ${v.job_id} --role asp --agent-id ${v.agent_id}${v.to_flag} \\\n`
    + `  --user-content "<localized complete Template 6.4 source below>" \\\n`
    + `  --list-label "[Decision ${v.short_id}] ${v.label_placeholder} — refund or evaluation" \\\n`
    + `  --source-event ${v.source_event} \\\n`
    + `  --decision-id "${v.decision_id}" \\\n`
    + `  --choices-json '${v.choices_json}' \\\n`
    + `  --expires-at ${v.expires_at} \\\n`
    + `  --refund-display-b64 "${v.refund_display_b64}" \\\n`
    + `  --template-vars-b64 "${v.template_vars_b64}"\n`
    + `\`\`\`\n`
    + `\n`
    + `=== BEGIN TEMPLATE 6.4 SOURCE ===\n`
    + `${v.source_template}\n`
    + `=== END TEMPLATE 6.4 SOURCE ===\n`
    + `\n`
    + `After \`request-prompt\` succeeds, end this turn and wait for the ASP owner's reply.`;
}

// upstream: flow.rs::reject_expire_time
export function rejectExpireTime(message) {
  const t = has(message) ? asI64(get(message, 'expireTime')) : undefined;
  return t !== undefined && BigInt(t) > 0n ? t : undefined;
}

// upstream: flow.rs inline_task_fields closure
function inlineTaskFields(prefetched, jobId, agentId, fields) {
  const render = (p) => {
    let out = '**Task fields** (pre-fetched; use directly — skip the `common context` call unless a value below is empty / null):\n';
    let any = false;
    for (const f of fields) {
      let line;
      if (f === 'title' && p.title !== '') line = `  - title: ${p.title}\n`;
      else if (f === 'description' && p.description !== '') line = `  - description: ${p.description}\n`;
      else if (f === 'tokenAmount' && p.tokenAmount !== '') line = `  - tokenAmount: ${p.tokenAmount}\n`;
      else if (f === 'tokenSymbol' && p.tokenSymbol !== '' && p.tokenSymbol !== '?') line = `  - tokenSymbol: ${p.tokenSymbol}\n`;
      else if (f === 'buyerAgentId' && nonEmpty(p.userAgentId) !== undefined) line = `  - buyerAgentId: ${p.userAgentId}\n`;
      else if (f === 'providerAgentId' && nonEmpty(p.providerAgentId) !== undefined) line = `  - providerAgentId: ${p.providerAgentId}\n`;
      else if (f === 'paymentMode' && has(p.paymentMode)) line = `  - paymentMode: ${p.paymentMode} (${is(p.paymentMode, 1) ? 'escrow' : is(p.paymentMode, 3) ? 'x402' : 'unknown'})\n`;
      else if (['serviceId', 'serviceTokenAddress', 'serviceTokenAmount', 'serviceParams'].includes(f) && nonEmpty(p[f]) !== undefined) line = `  - ${f}: ${p[f]}\n`;
      if (line !== undefined) { out += line; any = true; }
    }
    return any ? out : undefined;
  };
  const rendered = has(prefetched) ? render(prefetched) : undefined;
  if (rendered !== undefined) return rendered;
  const v = { job_id: jobId, agent_id: agentId, _0: fields.join(' + ') };
  return `**Load task context first**:\n`
    + `\`\`\`bash\n`
    + `onchainos agent common context ${v.job_id} --role asp --agent-id ${v.agent_id}\n`
    + `\`\`\`\n`
    + `Extract ${v._0} (needed below).\n`;
}

// upstream: flow.rs::display_notify
export function displayNotify(header, contentText, terminalHint) {
  const v = { header, content: contentText, tail: has(terminalHint) ? `\n${terminalHint}\n` : '' };
  return `[System notification] ${v.header}\n`
    + `[Role] ASP (Agent Service ASP)\n`
    + `\n`
    + `**Notify the user, then end the turn** (🌐 **Localize first** — rewrite the content below in the user's language before sending; do NOT pass the English template verbatim to a non-English user. If the content still contains \`<...>\` placeholders such as \`<title>\`, fill them from the task context — \`onchainos agent common context\` — before sending; never send a literal placeholder):\n`
    + `\`\`\`bash\n`
    + `onchainos agent user-notify --content "<localized content shown below>"\n`
    + `\`\`\`\n`
    + `content:\n`
    + `${v.content}\n`
    + `${v.tail}`;
}

// upstream: flow.rs::sub_asp_accepted_start
function subAspAcceptedStart(header, contentText, taskFields, jobId, agentId) {
  const v = { header, content: contentText, task_fields: taskFields, job_id: jobId, agent_id: agentId };
  return `[System notification] ${v.header}\n`
    + `[Role] ASP (Agent Service ASP)\n`
    + `\n`
    + `${v.task_fields}\n`
    + `**Step 1 — Notify the ASP owner** (localize the fixed template first; fill any \`<...>\` value from the task context and never send a literal placeholder):\n`
    + `\`\`\`bash\n`
    + `onchainos agent user-notify --content "<localized content shown below>"\n`
    + `\`\`\`\n`
    + `content:\n`
    + `${v.content}\n`
    + `\n`
    + `**Step 2 — Start service execution now.** Reuse the registered Service's existing AI/Skill workflow with the authoritative description, serviceParams, and attachments above. Do not re-run provider acceptance and do not send filler to the Buyer Agent.\n`
    + `\n`
    + `- If this execution produces a deliverable now, hand it to the §1.6 delivery command for job \`${v.job_id}\` as ASP \`${v.agent_id}\`.\n`
    + `- If the Service is schedule/event driven, initialize its existing schedule/listener and then end the turn; do not invent an empty deliverable.\n`;
}

// upstream: flow.rs::user_attachment_received_cli
async function userAttachmentReceivedCli(jobId, agentId, shortId, message) {
  const msgStr = (key) => (has(message) ? asStr(get(message, key)) : undefined) ?? '';
  const fileKey = msgStr('fileKey'), digest = msgStr('digest'), salt = msgStr('salt'), nonce = msgStr('nonce'), secret = msgStr('secret');
  const filename = has(message) ? asStr(get(message, 'filename')) : undefined;
  if (fileKey === '' || digest === '' || salt === '' || nonce === '' || secret === '') {
    const missing = [['fileKey', fileKey], ['digest', digest], ['salt', salt], ['nonce', nonce], ['secret', secret]].filter(([, x]) => x === '').map(([k]) => k);
    const v = { fields: missing.join(', '), short_id: shortId };
    return `[user_attachment_received_cli] ERROR: encryption metadata incomplete — missing: ${v.fields}. The caller must include all 6 fields (fileKey/digest/salt/nonce/secret/filename) in --message JSON.\n`
      + `\n`
      + `[Your next action] Notify the user that the attachment could not be downloaded.\n`
      + `\n`
      + `\`\`\`bash\n`
      + `onchainos agent user-notify --content "<translate: [Job ${v.short_id}] User Agent attachment download failed — encryption metadata incomplete. The User Agent may need to re-send.>"\n`
      + `\`\`\`\n`
      + `\n`
      + `❌ Do NOT reply to the User Agent via okx-a2a session send.\n`
      + `**End this turn.**\n`;
  }
  let localPath;
  try { localPath = await fileDownload(fileKey, agentId, digest, salt, nonce, secret, filename); } catch (e) {
    const v = { e: displayTop(e), short_id: shortId };
    process.stderr.write(`[user_attachment_received_cli] download failed: ${v.e}\n`);
    return `[user_attachment_received_cli] ERROR: file download failed: ${v.e}\n`
      + `\n`
      + `[Your next action] Notify the user that the attachment could not be downloaded.\n`
      + `\n`
      + `\`\`\`bash\n`
      + `onchainos agent user-notify --content "<translate: [Job ${v.short_id}] User Agent attachment download failed. Please check network and retry.>"\n`
      + `\`\`\`\n`
      + `\n`
      + `❌ Do NOT reply to the User Agent via okx-a2a session send.\n`
      + `**End this turn.**\n`;
  }
  let savePath;
  try {
    if (!existsSync(localPath)) throw new Error(`downloaded file not found: ${localPath}`);
    let dir;
    try { dir = attachmentsDir(jobId); } catch (e) { throw new Error(displayTop(e)); }
    try { mkdirSync(dir, { recursive: true }); } catch (e) { throw new Error(`mkdir failed: ${ioErrorText(e)}`); }
    const name = fileName(localPath);   // Path::file_name (`x/.` → `x`; `..` / root → None)
    if (name === undefined) throw new Error(`invalid file path: ${localPath}`);
    const dest = dedupDest(dir, name);
    try { renameSync(localPath, dest); } catch {
      try { copyFileSync(localPath, dest); } catch (e) { throw new Error(`copy failed: ${ioErrorText(e)}`); }
      try { rmSync(localPath, { force: true }); } catch {}
    }
    savePath = dest;
  } catch (e) {
    process.stderr.write(`[user_attachment_received_cli] save-to-job-dir failed: ${e.message}\n`);
    savePath = localPath;
  }
  const v = { save_path: savePath, att_notify: content.userAttachmentReceivedUserNotify(jobId) };
  return `[user_attachment_received_cli] ✓ Attachment downloaded and saved: ${v.save_path}\n`
    + `\n`
    + `[Your next action] Translate the notification below to the user's language, then dispatch it. End the turn after notifying.\n`
    + `\n`
    + `Canonical content:\n`
    + `  ${v.att_notify}\n`
    + `\n`
    + `\`\`\`bash\n`
    + `onchainos agent user-notify --content "<your translated content>"\n`
    + `\`\`\`\n`
    + `\n`
    + `❌ Do NOT reply to the User Agent via okx-a2a session send.\n`
    + `**End this turn.**\n`;
}

// upstream: flow.rs::generate_next_action → playbook text
export async function generateNextAction(jobId, eventStr, agentId, jobTitle, data, prefetched, message) {
  const shortId = shortJobId(jobId);
  const titleDisplay = has(jobTitle) ? jobTitle : '<title>';
  const taskFields = (fields) => inlineTaskFields(prefetched, jobId, agentId, fields);
  const v = { job_id: jobId, agent_id: agentId };
  v.execute_task = `Reuse the designated registered Service's existing AI/Skill workflow. Feed it the authoritative description, complete serviceParams, and forwarded attachments from the Task fields/session; do not substitute an unrelated workflow and do not re-run provider acceptance.\n`
    + `\n`
    + `⚠️ If a new question about task details / acceptance criteria is still required, use the existing A2A session (resolve \`<buyerAgentId>\` from the Task fields above):\n`
    + `    \`\`\`bash\n`
    + `    okx-a2a xmtp-send \\\n`
    + `      --job-id ${v.job_id} \\\n`
    + `      --to-agent-id <buyerAgentId> \\\n`
    + `      --message "<plain natural-language question to the User Agent>" --json\n`
    + `    \`\`\`\n`
    + `End this turn after sending, wait for the reply; once you have the answer, start the work. Do not guess and produce a deliverable that misses the mark.`;
  v.terminal_session_hint = `ℹ️ Task is in terminal state — run the cleanup command (handles pending-decision cancellation automatically):\n`
    + `\`\`\`bash\n`
    + `onchainos agent session-cleanup --job-id ${v.job_id}\n`
    + `\`\`\`\n`
    + `Then follow the command's output to close conversations (if applicable).`;
  const event = parseStatusOrEvent(eventStr);
  const other = Event.isOther(event);

  // ── first pass (returns early) ──
  if (event === 'job_rejected') {
    const t = prefetched;
    if (has(t) && t.providerAgentId === agentId && is(t.jobType, 0) && is(t.status, 9) && isZeroDecimal(t.tokenAmount)) {
      return notification.freeJobRejectedFailed(jobId, t, message);
    }
    return arbitrationDecisionPlaybook(JOB_REJECTED, jobId, agentId, jobTitle, prefetched, message);
  }
  if (event === 'sub_user_reject') return arbitrationDecisionPlaybook(SUB_USER_REJECT, jobId, agentId, jobTitle, prefetched, message);
  if (other && event.startsWith('user_decision_')) {
    const sourceEvent = event.slice('user_decision_'.length);
    if (isDecisionSource(sourceEvent)) {
      const prefix = `${jobId}:${sourceEvent}:`;
      const decisionId = has(message) ? asStr(get(message, 'decisionId')) : undefined;
      if (!(decisionId !== undefined && decisionId.startsWith(prefix) && decisionId.length > prefix.length)) {
        return blockedResult('decision_metadata_missing', jobId, { sourceEvent });
      }
      const actionId = has(message) ? asStr(get(message, 'selectedActionId')) : undefined;
      const params = has(message) ? get(message, 'params') : undefined;
      if (actionId === undefined) return blockedResult('decision_metadata_missing', jobId, { sourceEvent });
      try {
        return stringify(buildSelectedResult(jobId, resolvedAction(sourceEvent, actionId, jobId, params)));
      } catch (e) {
        if (typeof e?.reasonCode !== 'function') throw e;
        return blockedResult(e.reasonCode(), jobId, { sourceEvent });
      }
    }
  }

  // ── second pass ──
  switch (event) {
    case 'provider_applied': {
      v.user_notify = content.providerAppliedUserNotify(jobId, agentId);
      return `[Current state] provider_applied (apply has been recorded on-chain)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `❌ Do NOT communicate with the User Agent. ❌ Do NOT deliver directly.\n`
        + `\n`
        + `**Step 1 — Use \`onchainos agent user-notify\` to push the apply-submitted notification to the user**:\n`
        + `\n`
        + `🌐 **Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
        + `\`\`\`bash\n`
        + `onchainos agent user-notify --content "<localized content shown below>"\n`
        + `\`\`\`\n`
        + `content (only the lines between \`=== BEGIN ===\` and \`=== END ===\` — do NOT add / drop fields, do NOT include the markers themselves, do NOT include anything below END):\n`
        + `=== BEGIN ===\n`
        + `${v.user_notify}\n`
        + `=== END ===\n`
        + `\n`
        + `[Follow-up events]\n`
        + `- job_accepted → User Agent has confirm-accepted, escrow funding complete.\n`;
    }
    case 'job_accepted': {
      v.user_notify = content.jobAcceptedUserNotify(jobId, agentId);
      v.task_fields = taskFields(['title', 'description', 'tokenAmount', 'tokenSymbol', 'serviceId', 'serviceParams', 'buyerAgentId']);
      return `[Current state] job_accepted (your provider acceptance is confirmed)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `[Your next action (strict order, do not skip steps)]\n`
        + `\n`
        + `${v.task_fields}\n`
        + `**Step 1 — Notify the ASP owner (acceptance succeeded) via \`onchainos agent user-notify\`**:\n`
        + `\n`
        + `🌐 **Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
        + `\`\`\`bash\n`
        + `onchainos agent user-notify --content "<localized content shown below>"\n`
        + `\`\`\`\n`
        + `content:\n`
        + `${v.user_notify}\n`
        + `\n`
        + `Fill the \`<title>\` / \`<description>\` / \`<tokenAmount>\` / \`<tokenSymbol>\` placeholders from the **Task fields** block above.\n`
        + `⚠️ Do NOT send any A2A acceptance filler to the Buyer Agent — both sides receive the authoritative \`job_accepted\` system event.\n`
        + `\n`
        + `**Step 2 — Start the designated Service workflow and prepare the deliverable**:\n`
        + `${v.execute_task}\n`
        + `\n`
        + `**Step 3 — Deliver** (single CLI command — handles file upload, peer notification, on-chain submit, and local save internally):\n`
        + `\n`
        + `⚠️ Do NOT call \`okx-a2a file upload\` or \`okx-a2a xmtp-send\` yourself — the \`deliver\` CLI handles all of this internally:\n`
        + `  - file upload (when needed) → XMTP-send \`[intent:deliver]\` to the User Agent → on-chain submit → local persistent save.\n`
        + `  - Text deliverables over 500 Unicode characters are auto-converted to a \`.md\` file and sent as a file attachment; if conversion/upload fails, the CLI falls back to inline text.\n`
        + `  - A2A delivery must succeed before a single task can be submitted on-chain. Subscription delivery never calls the single-task submit API.\n`
        + `\n`
        + `▸ **File deliverable** — pass \`--file\` with the local file path:\n`
        + `\`\`\`bash\n`
        + `onchainos agent deliver ${v.job_id} --file "<local file path>" --agent-id ${v.agent_id}\n`
        + `\`\`\`\n`
        + `\n`
        + `▸ **Text deliverable** — pass only the heredoc-wrapped \`--deliverable-text\` (exactly one delivery-input flag):\n`
        + `\`\`\`bash\n`
        + `onchainos agent deliver ${v.job_id} --agent-id ${v.agent_id} \\\n`
        + `  --deliverable-text "$(cat <<'OKX_TEXT_EOF'\n`
        + `<full text deliverable content>\n`
        + `OKX_TEXT_EOF\n`
        + `)"\n`
        + `\`\`\`\n`
        + `\n`
        + `**Step 4 — After Step 3 ends this turn immediately** (do NOT send any filler \`okx-a2a xmtp-send\` / \`onchainos agent user-notify\` — the CLI already notified the User Agent).\n`
        + `\n`
        + `The backend now opens the Buyer review after successful submission. The ASP does **not** wait for \`job_submitted\`; end this turn and wait for the terminal result.\n`
        + `\n`
        + `[Follow-up events]\n`
        + `- \`job_completed\` (User Agent reviewed and accepted) — auto-rate the User Agent + notify the user\n`
        + `- \`job_rejected\` with a zero-price one-time task at Failed(9) — notify the ASP owner that the task failed, then clean up; no refund/evaluation decision\n`
        + `- \`job_rejected\` for a paid task — push the refund-vs-evaluation decision to the user\n`;
    }
    case 'job_submitted': {
      v.user_notify = content.jobSubmittedUserNotify(jobId);
      return `[System notification] job_submitted (deliverable confirmed on-chain; task state is now submitted)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `⚠️ The deliverable was already sent by \`onchainos agent deliver\`; this event **must NOT trigger a second A2A send** to the User Agent. The notification below targets the ASP owner only.\n`
        + `\n`
        + `**Step 1 — Notify the user of the submit milestone via \`onchainos agent user-notify\`**:\n`
        + `\n`
        + `🌐 **Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
        + `\`\`\`bash\n`
        + `onchainos agent user-notify --content "<localized content shown below>"\n`
        + `\`\`\`\n`
        + `content:\n`
        + `${v.user_notify}\n`
        + `\n`
        + `**Step 2 — End this turn.** Wait for \`job_completed\` / \`job_rejected\` to drive the next action.\n`
        + `\n`
        + `When \`job_completed\` or \`job_rejected\` arrives, use the fresh task status and price to select the terminal or paid-dispute path.\n`
        + `\n`
        + `[Follow-up events]\n`
        + `- \`job_completed\` (review passed) — auto-rate the User Agent + notify the user\n`
        + `- \`job_rejected\` with a zero-price one-time task at Failed(9) — notify Failed and clean up; no refund/evaluation decision\n`
        + `- \`job_rejected\` for a paid task — push the refund-vs-evaluation decision to the user\n`;
    }
    case 'raise_arbitration': case 'dispute_raise': case 'agree_refund':
      return blockedResult('decision_metadata_missing', jobId, { sourceEvent: JOB_REJECTED, receivedEvent: event });
    case 'dispute_approved':
      return `[Current state] dispute_approved (compatibility receipt)\n`
        + `[Role] ASP\n`
        + `\n`
        + `Evaluation creation is already submitted by \`approveAndCreateDispute\`. End this turn and continue when the matching evaluation event or fresh status arrives.\n`
        + `jobId=${v.job_id}\n`;
    case 'raise_subscription_arbitration': case 'sub_dispute': case 'sub_agree_refund':
      return blockedResult('decision_metadata_missing', jobId, { sourceEvent: SUB_USER_REJECT, receivedEvent: event });
    case 'job_completed':
      return jobCompleted.handle(jobId, agentId);
    case 'dispute_resolved': {
      v.dispute_won_claim = content.disputeWonWithClaimUserNotify(jobId);
      v.dispute_won_no_claim = content.disputeWonNoClaimUserNotify(jobId);
      v.dispute_lost = content.disputeLostUserNotify(jobId);
      v.rating_notify = content.ratingSubmittedUserNotify(jobId);
      v.task_fields = taskFields(['title', 'tokenAmount', 'tokenSymbol', 'buyerAgentId']);
      return `[Current state] dispute_resolved (evaluation ruling delivered)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `⚠️ **Determining win/loss**: read \`message.jobStatus\` from the system notification envelope you just received:\n`
        + `- \`jobStatus = "complete"\` → **you (ASP) won**; funds released to you\n`
        + `- \`jobStatus = "failed"\` → **you (ASP) lost**; funds refunded to the User Agent\n`
        + `[Your next action (branch by win/loss)]\n`
        + `\n`
        + `⚠️ Do NOT send \`okx-a2a session send\` \`ruling supports party X\` filler to the User Agent — both sides receive the \`dispute_resolved\` system event.\n`
        + `\n`
        + `${v.task_fields}\n`
        + `━━━━━━━━━━━━━ Branch A: jobStatus=complete (ASP won) ━━━━━━━━━━━━━\n`
        + `\n`
        + `**A-Step 1 — Check claimable rewards (account-pull)**:\n`
        + `\`\`\`bash\n`
        + `onchainos agent asp-claimable --agent-id ${v.agent_id}\n`
        + `\`\`\`\n`
        + `Lines with a \`•\` marker in stdout indicate a non-zero claimable amount for that token.\n`
        + `\n`
        + `**A-Step 2 — Claim everything in one shot when amounts are non-zero** (skip if claimable output is all zero):\n`
        + `\`\`\`bash\n`
        + `onchainos agent asp-claim-rewards --agent-id ${v.agent_id}\n`
        + `\`\`\`\n`
        + `Record stdout's txHash + the actual amount / token claimed (used to notify the user in the next step).\n`
        + `\n`
        + `**A-Step 3 — Notify the user of the win + claim result via \`onchainos agent user-notify\`**:\n`
        + `\n`
        + `Field values for the content template come from the **Task fields** block above.\n`
        + `⚠️ content is the **chat the user will see** — plain natural language; **do NOT use** skill names / event names / state names / CLI flags or other technical jargon.\n`
        + `🌐 **Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
        + `\`\`\`bash\n`
        + `onchainos agent user-notify --content "<localized content shown below>"\n`
        + `\`\`\`\n`
        + `content (choose based on whether A-Step 2 actually claimed):\n`
        + `    Claimed:\n`
        + `${v.dispute_won_claim}\n`
        + `    Nothing to claim:\n`
        + `${v.dispute_won_no_claim}\n`
        + `\n`
        + `🛑 Do NOT end this turn — A-Step 4 (auto-rate) and A-Step 4.5 (notify rating) below are MANDATORY.\n`
        + `\n`
        + `**A-Step 4 — 🛑 Auto-rate the User Agent (MANDATORY):**\n`
        + `Based on the task description, requirements clarity, communication, and dispute outcome (you won), generate:\n`
        + `  - Score: 0.00–5.00 (two decimal places). Guide: ASP won dispute → User Agent was likely at fault; 0.00–3.00 depending on severity. If the dispute was a misunderstanding, score higher.\n`
        + `  - Comment: one sentence, ≤100 characters, evaluating how well the deliverable matches the description.\n`
        + `Then execute:\n`
        + `\`\`\`bash\n`
        + `onchainos agent feedback-submit --agent-id <buyerAgentId> --creator-id ${v.agent_id} --score <X.XX> --task-id ${v.job_id} --description "<comment, ≤100 chars>"\n`
        + `\`\`\`\n`
        + `⚠️ \`--agent-id\` is the User Agent being rated (buyerAgentId from the **Task fields** block at the top); \`--creator-id\` is the ASP's own agent id (${v.agent_id}).\n`
        + `\n`
        + `**A-Step 4.5 — Notify the user of the submitted rating**:\n`
        + `🌐 **Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
        + `After feedback-submit, run \`onchainos agent user-notify\` to notify the user:\n`
        + `- ✅ **Success** (output contains \`txHash\`):\n`
        + `\`\`\`bash\n`
        + `onchainos agent user-notify --content "<localized content shown below>"\n`
        + `\`\`\`\n`
        + `content (fill \`<score>\` with the X.XX value and \`<description>\` with the comment you just used in A-Step 4; fill \`<title>\` from task context):\n`
        + `${v.rating_notify}\n`
        + `- ❌ **Failure** (error / non-zero exit code) → silently skip; do NOT notify the user, do NOT retry.\n`
        + `\n`
        + `━━━━━━━━━━━━━ Branch B: jobStatus=failed (ASP lost) ━━━━━━━━━━━━━\n`
        + `\n`
        + `**B-Step 1 — Notify the user of the loss via \`onchainos agent user-notify\`**:\n`
        + `\n`
        + `Field values for the content template come from the **Task fields** block above (same fields as Branch A).\n`
        + `⚠️ Same as A-Step 3 — content plain natural language; no technical jargon.\n`
        + `🌐 **Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
        + `\`\`\`bash\n`
        + `onchainos agent user-notify --content "<localized content shown below>"\n`
        + `\`\`\`\n`
        + `content:\n`
        + `${v.dispute_lost}\n`
        + `\n`
        + `🛑 Do NOT end this turn — B-Step 2 (auto-rate) and B-Step 2.5 (notify rating) below are MANDATORY.\n`
        + `\n`
        + `**B-Step 2 — 🛑 Auto-rate the User Agent (MANDATORY):**\n`
        + `Based on the task description, requirements clarity, and dispute outcome (you lost — User Agent's rejection was upheld), generate:\n`
        + `  - Score: 0.00–5.00 (two decimal places). Guide: ASP lost dispute → User Agent was likely right; 3.00–5.00. Adjust based on whether the dispute felt fair.\n`
        + `  - Comment: one sentence, ≤100 characters, evaluating how well the deliverable matches the description.\n`
        + `Then execute:\n`
        + `\`\`\`bash\n`
        + `onchainos agent feedback-submit --agent-id <buyerAgentId> --creator-id ${v.agent_id} --score <X.XX> --task-id ${v.job_id} --description "<comment, ≤100 chars>"\n`
        + `\`\`\`\n`
        + `⚠️ \`--agent-id\` is the User Agent being rated (buyerAgentId from the **Task fields** block at the top); \`--creator-id\` is the ASP's own agent id (${v.agent_id}).\n`
        + `\n`
        + `**B-Step 2.5 — Notify the user of the submitted rating**:\n`
        + `🌐 **Localize first** — rewrite the content below in the user's language before sending. Do NOT pass the English template verbatim to a non-English user.\n`
        + `After feedback-submit, run \`onchainos agent user-notify\` to notify the user:\n`
        + `- ✅ **Success** (output contains \`txHash\`):\n`
        + `\`\`\`bash\n`
        + `onchainos agent user-notify --content "<localized content shown below>"\n`
        + `\`\`\`\n`
        + `content (fill \`<score>\` with the X.XX value and \`<description>\` with the comment you just used in B-Step 2; fill \`<title>\` from task context):\n`
        + `${v.rating_notify}\n`
        + `- ❌ **Failure** (error / non-zero exit code) → silently skip; do NOT notify the user, do NOT retry.\n`
        + `\n`
        + `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
        + `\n`
        + `${v.terminal_session_hint}\n`;
    }
    case 'job_refunded':
      return `[Current state] job_refunded (funds refunded to the User Agent)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `[Your next action]\n`
        + `\n`
        + `⚠️ Do NOT send \`okx-a2a session send\` \`refund on-chain\` filler to the User Agent — both sides already receive the \`job_refunded\` system event.\n`
        + `${v.terminal_session_hint}\n`
        + `\n`
        + `**End this turn directly**; the refund flow is fully complete.\n`;
    case 'job_disputed': {
      v.task_fields = taskFields(['buyerAgentId']);
      return `[Current state] job_disputed (evaluation is on-chain; CLI auto-submits evidence on this event)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `🛑 **This event triggers an AUTOMATIC evidence upload — no user interaction**.\n`
        + `The agent does NOT ask the user for evidence; it recovers the exact evaluation reason and pulls the full chat history from this sub\n`
        + `session, calls \`dispute upload\` (which also auto-attaches the deliverable copy saved under\n`
        + `\`~/.onchainos/deliverables/asp/${v.job_id}/\`), and then notifies the user via\n`
        + `\`onchainos agent user-notify\`. **Do NOT** use \`pending-decisions-v2 request\` for this event.\n`
        + `**Do NOT** \`okx-a2a session send\` anything to the User Agent — both sides see the evaluation via on-chain events.\n`
        + `\n`
        + `${v.task_fields}\n`
        + `**Step 1 — Recover the evaluation reason:**\n`
        + `Find the latest \`[ARBITRATION_REASON_CONTEXT]\` message in this task conversation whose \`jobId\` is \`${v.job_id}\`, \`providerAgentId\` is \`${v.agent_id}\`, \`taskType\` is \`one_time\`, and \`resumeEvent\` is \`job_disputed\`. Preserve its \`reason\` exactly.\n`
        + `The matching context is required for this evidence upload. When it is unavailable, return \`arbitration_reason_context_missing\` and end this turn.\n`
        + `\n`
        + `**Step 2 — Pull this sub session's chat history** (use \`buyerAgentId\` from the **Task fields** block above):\n`
        + `\n`
        + `\`\`\`bash\n`
        + `okx-a2a session history --job-id ${v.job_id} --to-agent-id <buyerAgentId> --json\n`
        + `\`\`\`\n`
        + `\n`
        + `**Step 3 — Format the evaluation reason and chat history as the \`--text\` body**:\n`
        + `\n`
        + `\`\`\`\n`
        + `==== ASP evaluation reason (from ARBITRATION_REASON_CONTEXT) ====\n`
        + `<exact reason>\n`
        + `==== Negotiation / delivery chat history (from okx-a2a session history) ====\n`
        + `[time] User Agent(<agentId>): ...\n`
        + `[time] ASP(<agentId>): ...\n`
        + `... (chronological; key checkpoints: ASP's cold-start opener / task scope clarifications / ASP's capability confirmation / your deliver message / each side's key contention points)\n`
        + `\`\`\`\n`
        + `\n`
        + `⚠️ **\`--text\` is capped at 16 KB** — if the chat history is long, **keep only** the key checkpoints (opener / scope clarifications / capability confirmation / deliverable / each side's key contention points) and prepend \`(key checkpoints extracted)\`; do NOT blindly drop the first N entries.\n`
        + `If history is genuinely empty, pass a minimal placeholder like \`(no chat history available)\` so \`--text\` is non-empty.\n`
        + `\n`
        + `**Step 4 — Upload (off-chain multipart):**\n`
        + `\`\`\`bash\n`
        + `onchainos agent dispute upload ${v.job_id} --role asp --agent-id ${v.agent_id} --text "<evaluation reason + chat history block>"\n`
        + `\`\`\`\n`
        + `The CLI auto-attaches every entry under \`~/.onchainos/deliverables/asp/${v.job_id}/manifest.json\` as multipart \`files[]\` parts — **do NOT pass \`--file\`**; the manifest covers the deliverable copy saved at \`deliver\` time. If the upload fails, retry up to 3 times; if it keeps failing, still proceed to Step 5 — the on-chain evaluation will continue with the available evidence.\n`
        + `\n`
        + `**Step 5 — Notify the user (after upload returns):**\n`
        + `\n`
        + `content:\n`
        + `    [Evaluation opened] Evaluation for job \`${v.job_id}\` is on-chain.\n`
        + `    - Evaluation status: Evidence preparation\n`
        + `    - Status description: Evidence was submitted and the evidence stage is in progress.\n`
        + `    Awaiting the evaluator's verdict.\n`
        + `\n`
        + `**Step 6 — End this turn.** Do NOT \`okx-a2a session send\` anything to the User Agent.\n`
        + `\n`
        + `[Follow-up events]\n`
        + `- job_completed → won, funds released to the ASP\n`
        + `- dispute_resolved → lost, funds refunded to the User Agent\n`;
    }
    case 'job_created':
      return `[System notification] job_created (task is on-chain; no ASP-side action)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `Silently ignore; end this turn.\n`
        + `Designated tasks arrive via a \`job_asp_selected\` event when the User Agent designates this ASP.\n`;
    case 'job_asp_selected':
      return providerAssignmentPlaybook(jobId, agentId, ProviderAssignmentType.Single, prefetched, message);
    case 'job_asp_accept_expire':
      return has(prefetched) ? notification.jobAspAcceptExpire(jobId, prefetched, message) : notification.authoritativeContextRequired(jobId, event, ['taskDetail']);
    case 'job_asp_reject_closed':
      return has(prefetched) ? notification.jobAspRejectClosed(jobId, prefetched, message) : notification.authoritativeContextRequired(jobId, event, ['taskDetail']);
    case 'job_asp_reject_expire':
      return has(prefetched) ? notification.jobAspRejectExpire(jobId, prefetched, message) : notification.authoritativeContextRequired(jobId, event, ['taskDetail']);
    case 'job_expired': case 'submit_expired':
      return has(prefetched) ? notification.jobDeliveryExpired(jobId, prefetched, event) : notification.authoritativeContextRequired(jobId, event, ['taskDetail']);
    case 'sub_asp_claim_notify':
      return notification.subAspClaimNotify(jobId, message);
    case 'job_closed': case 'job_payment_mode_changed':
      v.event = event;
      return `[System notification] ${v.event} (User Agent-side tx receipt; not the ASP's concern)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `Silently ignore; end this turn. \n`;
    case 'reject_expired': case 'review_deadline_warn':
      v.event = event;
      return `[System notification] ${v.event} (User Agent-side timeout event; not the ASP's concern)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `Silently ignore; end this turn.\n`;
    case 'review_expired':
      return `[System notification] review_expired (review window expired; the User Agent did not accept in time)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `⚠️ **review_expired is just a window-timeout event; the task state is still submitted; funds are NOT auto-released**.\n`
        + `You need to actively call claimAutoComplete to pull the funds out of the escrow contract; only after on-chain confirmation does the state become completed.\n`
        + `\n`
        + `[Your next action (strict order)]\n`
        + `\n`
        + `**Step 1 — Call the CLI to claim the payment (on-chain):**\n`
        + `\`\`\`bash\n`
        + `onchainos agent claim-auto-complete ${v.job_id} --agent-id ${v.agent_id}\n`
        + `\`\`\`\n`
        + `CLI internals: POST /claimAutoComplete → uopData → sign uopHash → broadcast. Wait for the on-chain \`job_completed\` notification.\n`
        + `\n`
        + `⚠️ **After claim-auto-complete, end the turn directly**:\n`
        + `- Do NOT send any okx-a2a session send to the User Agent (filler in between; wait until the job_completed on-chain receipt arrives)\n`
        + `- Do NOT push to the user with \`onchainos agent user-notify\`\n`
        + `\n`
        + `[Follow-up events]\n`
        + `- \`job_completed\` (success) → next-action provides the funds-received script (push to user; conversation retained)\n`
        + `- \`job_completed\` (failed)  → retry claim-auto-complete per errorCode\n`;
    case 'submit_deadline_warn': {
      const userPrompt = content.submitDeadlineWarnUserPrompt(shortId);
      v.request_block = requestCommandBlock(jobId, 'asp', agentId, has(prefetched) ? prefetched.userAgentId : undefined, userPrompt,
        `[Decision ${shortId}] ${titleDisplay} submit decision`, 'submit_deadline_warn');
      return `[System notification] submit_deadline_warn (deadline for submitting the deliverable is approaching)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `🛑 **MUST push the submit-now/let-timeout decision via \`pending-decisions-v2 request\`** — \`onchainos agent user-notify\` is one-way (no reply relay) and a plain text reply doesn't reach the user-session; either path = the deadline silently expires → auto-refund to the User Agent.\n`
        + `❌ Do NOT \`okx-a2a session send\` the User Agent — the deadline warning is between the ASP and the user, not the User Agent's business.\n`
        + `\n`
        + `**Push the decision to the user (3-substep protocol; read ALL 3 before running any command)**:\n`
        + `\n`
        + `${v.request_block}\n`
        + `⚠️ **Do NOT auto-run \`onchainos agent deliver\` later** — only the user knows whether the deliverable is actually ready; the agent must not decide "deliverable is ready" on the user's behalf.\n`;
    }
    case 'evaluator_selected': case 'reveal_started': case 'vote_committed': case 'vote_revealed': case 'round_failed':
    case 'vote_commit_deadline_warn': case 'vote_reveal_deadline_warn':
      v.event = event;
      return `[System notification] ${v.event} (evaluation-internal event; handled by the evaluator)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `[Recommendation] Observe silently. After the \`dispute_resolved\` notification arrives, call next-action to wrap up.\n`;
    case 'user_attachment_received':
      return userAttachmentReceivedCli(jobId, agentId, shortId, message);
    case 'staked': case 'unstake_requested': case 'unstake_claimed': case 'unstake_cancelled': case 'stake_stopped': case 'cooldown_entered':
      v.event = event;
      return `[System notification] ${v.event} (evaluator staking lifecycle tx receipt; not the ASP's concern)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `Silently ignore; end this turn.\n`;
    case 'reward_claimed': {
      v.failed_notify = content.rewardClaimFailedUserNotify(jobId);
      v.claimed_notify = content.rewardClaimedUserNotify(jobId);
      return `[System notification] reward_claimed (claimRewards tx receipt)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `**Step 1 — Check the envelope's \`message.code\` field:**\n`
        + `- \`code\` non-zero (failed) → run \`onchainos agent user-notify\` to notify the user, then end the turn:\n`
        + `  \`\`\`bash\n`
        + `  onchainos agent user-notify --content "${v.failed_notify}"\n`
        + `  \`\`\`\n`
        + `\n`
        + `- \`code\` = 0 (success) → continue to Step 2.\n`
        + `\n`
        + `**Step 2 — Notify the user that the reward has arrived via \`onchainos agent user-notify\`:**\n`
        + `  \`\`\`bash\n`
        + `  onchainos agent user-notify --content "${v.claimed_notify}"\n`
        + `  \`\`\`\n`;
    }
    case 'job_auto_refunded':
      return `[System notification] job_auto_refunded (buyer/backend Refund V2 settlement receipt; not the ASP's concern)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `Silently ignore; end this turn.\n`;
    case 'wakeup_notify':
      return `[System notification] wakeup_notify (task wake-up after network / machine reboot)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `⚠️ This is a wake-up heartbeat event, **NOT** a business-driving event. The real business state is in the envelope.message.jobStatus field.\n`
        + `You should NOT use \`wakeup_notify\` as --event to run the script — this script is just for guidance.\n`
        + `\n`
        + `[Your next action (strict order)]\n`
        + `\n`
        + `**Step 1 — Read the real status from the envelope**:\n`
        + `From the wakeup_notify envelope that triggered this turn, read the \`message.jobStatus\` field (e.g. \`accepted\` / \`submitted\` / \`rejected\` / \`disputed\` / \`completed\` / \`failed\`, etc. — the real status string).\n`
        + `\n`
        + `**Step 2 — Use the real status to call next-action and fetch the current script**:\n`
        + `\`\`\`bash\n`
        + `onchainos agent next-action --role asp --agentId ${v.agent_id} --message '{"event":"<value of the message.jobStatus field>","jobId":"${v.job_id}"}'\n`
        + `\`\`\`\n`
        + `Follow the returned script for what to do in the current status.\n`
        + `\n`
        + `⚠️ **Do NOT** okx-a2a session send the User Agent something like \`I'm back online\` — the peer does not care about your connection status.\n`
        + `⚠️ If the Step 2 script is a passive-wait kind (e.g. status=accepted: ASP is working / status=submitted: waiting for User Agent review), only emit a \`task resumed\` notification and end the turn; do not proactively run business actions.\n`;
    case 'negotiate_reply':
      return `[System notification] negotiate_reply (User Agent-side negotiation relay event; not the ASP's concern)\n`
        + `[Recommendation] Ignore; no action needed.\n`;
    case 'attachment_added': case 'deliverable_received':
      return `[System notification] User Agent-side event; not the ASP's concern.\n`
        + `[Recommendation] Ignore; no action needed.\n`;
    case 'job_provider_reject':
      return `[System notification] job_provider_reject (your decline was registered; no further action).\n`
        + `${v.terminal_session_hint}\n`;
    case 'job_user_reject': {
      v.user_notify = content.jobUserRejectNotify(jobId);
      v.l10n = content.L10N_DISPATCH_SHORT;
      return `[Current state] job_user_reject (User Agent declined to fund / confirm-accept)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `**Notify the user, then end the turn** (🌐 translate template to user's language first):\n`
        + `${v.user_notify}\n`
        + `${v.l10n}\n`
        + `\n`
        + `\`\`\`bash\n`
        + `onchainos agent user-notify --content "<translated text>"\n`
        + `\`\`\`\n`
        + `❌ Do NOT okx-a2a session send the User Agent. ❌ Do NOT retry apply.\n`
        + `\n`
        + `${v.terminal_session_hint}\n`;
    }
    case 'sub_asp_selected': {
      const msgStr = (k) => { const s = has(message) ? asStr(get(message, k)) : undefined; return s !== undefined && s !== '' ? s : undefined; };
      const msgI64 = (k) => (has(message) ? asI64(get(message, k)) : undefined);
      const p = has(prefetched) ? prefetched : undefined;
      const title = msgStr('jobTitle') ?? msgStr('title') ?? (p && p.title !== '' ? p.title : undefined);
      const buyer = nonEmpty(msgStr('buyerAgentId') ?? (p ? p.userAgentId ?? undefined : undefined));
      const amount = nonEmpty(msgStr('tokenAmount') ?? (p ? p.tokenAmount : undefined));
      const symbolRaw = msgStr('tokenSymbol') ?? (p ? p.tokenSymbol : undefined);
      const symbol = symbolRaw !== undefined && symbolRaw !== '' && symbolRaw !== '?' ? symbolRaw : undefined;
      const trial = msgI64('trialType');
      const contentText = trial !== undefined && BigInt(trial) === 1n
        ? content.subAspSelectedTrialAspNotify(title, buyer, jobId, amount, symbol, msgI64('trialStartTime') ?? msgI64('trailStartTime'), msgI64('trialEndTime') ?? msgI64('trailEndTime'))
        : content.subAspSelectedAspNotify(title, buyer, jobId, amount, symbol, msgI64('subStartTime'), msgI64('subEndTime'));
      return subAspAcceptedStart('sub_asp_selected (subscription acceptance confirmed)', contentText,
        taskFields(['title', 'description', 'serviceParams', 'buyerAgentId', 'serviceId']), jobId, agentId);
    }
    case 'sub_complete_notify': {
      const t = has(message) ? asStr(get(message, 'jobTitle')) : undefined;
      const title = (t !== undefined && t !== '' ? t : undefined) ?? (has(prefetched) && prefetched.title !== '' ? prefetched.title : undefined);
      const periodEnd = has(message) ? asI64(get(message, 'subEndTime')) : undefined;
      return subCompleteNotify.handle(jobId, title, periodEnd);
    }
    case 'sub_close_notify': {
      const raw = has(message) ? (get(message, 'jobTitle') !== undefined ? get(message, 'jobTitle') : get(message, 'title')) : undefined;
      const t = asStr(raw);
      const title = t !== undefined && t !== '' ? t : undefined;
      const r = has(message) ? asStr(get(message, 'aspRejectReason')) : undefined;
      const aspRejectReason = r !== undefined && trim(r) !== '' ? r : undefined;
      return displayNotify('sub_close_notify (subscription closed)', content.subCloseNotifyAspNotify(title, jobId, aspRejectReason), v.terminal_session_hint);
    }
    case 'sub_failed_notify': {
      const t = has(prefetched) ? trim(prefetched.title) : '';
      v.title = t !== '' ? t : 'Subscription title unavailable';
      const text = `[Subscription Result Needs Reconciliation] ${v.title} (\`${v.job_id}\`) is in fresh Failed(9) status, but the authoritative backend detail does not expose whether this was a refund or a charge/conversion failure. The caller-provided \`sub_failed_notify\` title and reason fields are not trusted result evidence. Do not report either outcome, take a settlement action, or close the ASP session from this event. Wait for an authoritative lifecycle result or inspect the latest subscription status read-only.`;
      return displayNotify('sub_failed_notify (result cause unverified)', text, undefined);
    }
    case 'sub_asp_dispute': {
      v.task_fields = taskFields(['buyerAgentId']);
      return `[Current state] sub_asp_dispute (subscription evaluation on-chain; CLI auto-submits evidence on this event)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `🛑 **This event triggers an AUTOMATIC evidence upload — no user interaction**.\n`
        + `The agent does NOT ask the user for evidence; it recovers the exact evaluation reason and pulls the full chat history from this sub\n`
        + `session, calls \`dispute upload\` (which also auto-attaches the most recent 20 deliverables saved under\n`
        + `\`~/.onchainos/deliverables/asp/${v.job_id}/\`), and then notifies the user via\n`
        + `\`onchainos agent user-notify\`. **Do NOT** use \`pending-decisions-v2 request\` for this event.\n`
        + `**Do NOT** \`okx-a2a session send\` anything to the User Agent — both sides see the evaluation via on-chain events.\n`
        + `\n`
        + `${v.task_fields}\n`
        + `**Step 1 — Recover the evaluation reason:**\n`
        + `Find the latest \`[ARBITRATION_REASON_CONTEXT]\` message in this task conversation whose \`jobId\` is \`${v.job_id}\`, \`providerAgentId\` is \`${v.agent_id}\`, \`taskType\` is \`subscription\`, and \`resumeEvent\` is \`sub_asp_dispute\`. Preserve its \`reason\` exactly.\n`
        + `The matching context is required for this evidence upload. When it is unavailable, return \`arbitration_reason_context_missing\` and end this turn.\n`
        + `\n`
        + `**Step 2 — Pull this sub session's chat history** (use \`buyerAgentId\` from the **Task fields** block above):\n`
        + `\n`
        + `\`\`\`bash\n`
        + `okx-a2a session history --job-id ${v.job_id} --to-agent-id <buyerAgentId> --json\n`
        + `\`\`\`\n`
        + `\n`
        + `**Step 3 — Format the evaluation reason and chat history as the \`--text\` body**:\n`
        + `\n`
        + `\`\`\`\n`
        + `==== ASP evaluation reason (from ARBITRATION_REASON_CONTEXT) ====\n`
        + `<exact reason>\n`
        + `==== Negotiation / delivery chat history (from okx-a2a session history) ====\n`
        + `[time] User Agent(<agentId>): ...\n`
        + `[time] ASP(<agentId>): ...\n`
        + `... (chronological; key checkpoints: subscription scope / deliverable messages / each side's key contention points)\n`
        + `\`\`\`\n`
        + `\n`
        + `⚠️ **\`--text\` is capped at 16 KB** — if the chat history is long, **keep only** the key checkpoints and prepend \`(key checkpoints extracted)\`; do NOT blindly drop the first N entries.\n`
        + `If history is genuinely empty, pass a minimal placeholder like \`(no chat history available)\` so \`--text\` is non-empty.\n`
        + `\n`
        + `**Step 4 — Upload (off-chain multipart):**\n`
        + `\`\`\`bash\n`
        + `onchainos agent dispute upload ${v.job_id} --role asp --agent-id ${v.agent_id} --max-files 20 --text "<evaluation reason + chat history block>"\n`
        + `\`\`\`\n`
        + `The CLI auto-attaches the most recent 20 entries under \`~/.onchainos/deliverables/asp/${v.job_id}/manifest.json\` as multipart \`files[]\` parts — **do NOT pass \`--file\`**; the manifest covers the deliverable copies saved at delivery time. If the upload fails, retry up to 3 times; if it keeps failing, still proceed to Step 5 — the on-chain evaluation will continue with the available evidence.\n`
        + `\n`
        + `**Step 5 — Notify the user (after upload returns):**\n`
        + `\n`
        + `content:\n`
        + `    [Evaluation opened] Subscription evaluation for job \`${v.job_id}\` is on-chain.\n`
        + `    - Evaluation status: Evidence preparation\n`
        + `    - Status description: Evidence was submitted and the evidence stage is in progress.\n`
        + `    Awaiting the evaluator's verdict.\n`
        + `\n`
        + `**Step 6 — End this turn.** Do NOT \`okx-a2a session send\` anything to the User Agent.\n`
        + `\n`
        + `[Follow-up events]\n`
        + `- job_completed → won, funds released to the ASP\n`
        + `- dispute_resolved → lost, funds refunded to the User Agent\n`;
    }
    case 'sub_renew':
      return `[System notification] sub_renew — the subscription renewed; the previous period's income is now claimable.\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `**Step 1 — Claim the accrued income (your own funds; run as-is):**\n`
        + `\`\`\`bash\n`
        + `onchainos agent subscribe-asp-claim ${v.job_id} --agent-id ${v.agent_id}\n`
        + `\`\`\`\n`
        + `CLI internals: POST /subscribe/{subId}/aspClaim (subId == jobId) → uopData → sign → broadcast. It claims everything outstanding for this subscription in one shot.\n`
        + `**Step 2 — Report:** on success push a short localized note via \`onchainos agent user-notify --content "<claim submitted, tx …>"\` — a background session's reply text never reaches the operator. If the CLI reports nothing claimable / already claimed, end the turn silently.\n`
        + `Do NOT \`okx-a2a session send\` anything to the User Agent — this involves no buyer action.\n`;
    case 'sub_open':
      return providerAssignmentPlaybook(jobId, agentId, ProviderAssignmentType.Subscription, prefetched, message);
    case 'sub_created': case 'sub_cancel': case 'sub_trial_into_active': case 'sub_expire_warn': case 'sub_reject_refund_notify': case 'sub_asp_agree':
      v.event = event;
      return `[System notification] ${v.event} (obsolete or not handled on the ASP side in this slice)\n`
        + `[Role] ASP (Agent Service ASP)\n`
        + `\n`
        + `Silently ignore; end this turn.\n`;
    default:
      break;
  }
  if (other && event.startsWith('user_decision_')) {
    v.source = event.slice('user_decision_'.length);
    v.reply = trim(has(data) ? data : '');
    if (v.source === 'submit_deadline_warn') {
      return `[User decision relay] source_event=\`submit_deadline_warn\`, user's verbatim reply: \`${v.reply}\`\n`
        + `\n`
        + `**Semantic mapping** — decide which intent the user's reply means:\n`
        + `\n`
        + `  • **Submit now** — user wants to deliver immediately (typical intents: 立即提交 / 我提交 / submit now / I'll deliver / ready / 现在交). Route: call \`onchainos agent next-action --role asp --agentId ${v.agent_id} --message '{"event":"job_accepted","jobId":"${v.job_id}"}'\` and run its Step 2-3 (skip Step 1 apply-accepted notification — user already knows).\n`
        + `  • **Let it timeout** — user lets the deadline pass (typical intents: silence / 算了 / 不交了 / let it timeout / skip / 放弃). Route: end the turn; the chain will fire \`submit_expired\` and the backend automatically refunds the User Agent without a client-side claim.\n`
        + `\n`
        + `If ambiguous: re-ask via \`pending-decisions-v2 request\` (\`--source-event submit_deadline_warn\`).\n`;
    }
    if (v.source === 'cli_failed') {
      return `[User decision relay] source_event=\`cli_failed\`, user's verbatim reply: \`${v.reply}\`\n`
        + `\n`
        + `The original \`onchainos agent <cmd>\` failed and you asked the user how to proceed. **Semantic mapping** — decide what the user means and act accordingly (no on-chain action by default):\n`
        + `\n`
        + `  • **Retry** — user wants you to re-run the same CLI command (typical intents: A / 选A / retry / 重试 / try again / 再来一次 / 再试一次). Action: re-execute the **exact same** CLI you previously ran (same args, same job_id). If it fails again, do NOT loop — enqueue **one more** \`pending-decisions-v2 request --source-event cli_failed\` and end the turn.\n`
        + `  • **Dismiss** — user takes manual control of this step (typical intents: B / 选B / dismiss / 不再提示 / skip prompts / 我自己处理 / let me handle it). Action: end the turn. Do not re-prompt; the user owns this step now.\n`
        + `  • **New instruction** — user gives a corrective instruction in natural language (e.g. \`把 token-symbol 改成 USDT 再试\` / \`change --token-symbol to USDT and retry\` / \`用 endpoint https://... 重试\`). Action: parse the modification, rebuild the CLI invocation with the user's adjustment, and execute once. Treat the result as a fresh attempt (success → continue the original scene; failure → enqueue another \`cli_failed\` decision).\n`
        + `\n`
        + `⚠️ Do NOT execute any on-chain action that wasn't part of the original failed command — the user reply only authorizes retry/edit of the failed step, not unrelated new actions.\n`
        + `⚠️ If the reply is truly ambiguous (e.g. unrelated chitchat / a non-committal \`hmm\` / \`got it\`), re-ask via \`pending-decisions-v2 request\` with the same \`--to-agent-id\` as the incoming relay's \`[to: …]\` header (OMIT it for \`[to: backup]\` / backup subs — NEVER your own agentId) and \`--source-event cli_failed\`. **\`--user-content\` must be localized to the user's language** (detect from the user's verbatim reply / prior turn) before sending. Reference (English): "I didn't catch your reply, please clarify: A=retry  B=stop prompting  C=tell me what to change".\n`;
    }
    return `[User decision relay] source_event=\`${v.source}\` (no specific routing rule defined for this scene), user's verbatim reply: \`${v.reply}\`\n`;
  }
  return `[Unknown state] ${event}\n`;
}

