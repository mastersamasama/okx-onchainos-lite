// ASP submits a deliverable — upstream task/asp/deliver.rs.
// One-shot tasks: prepare → A2A send → on-chain submit → local save (plain-text output).
// Subscription tasks: prepare → A2A send, never a submit (four-state JSON output).
import { existsSync, writeFileSync } from 'node:fs';
import { stringify } from '../../../core/json.mjs';
import { auditLog } from '../../../core/audit.mjs';
import { rustTempDir } from '../../../core/qr.mjs';
import { PRETTY } from '../../../config.mjs';
import { displayTop } from '../../../wallet/api.mjs';
import { at, asStr, asI64 } from '../../../core/rs/value.mjs';
import { trim, charCount } from '../../../core/rs/str.mjs';
import { parseI64 } from '../../../core/rs/num.mjs';
import { localNow } from '../../../core/rs/time.mjs';
import { PaymentMode } from '../common/payment-mode.mjs';
import { Status } from '../common/state-machine.mjs';
import { xmtpSend, fileUpload } from '../common/okx-a2a.mjs';
import { handleSave } from '../common/deliverables.mjs';
import { resolveWalletByAgentId, signUopAndBroadcast, extractBizType } from '../signing.mjs';
import { JOB_TYPE_SUBSCRIBE, Routing, SubscriptionDetail, SubStatus, fetchDetail, asStringField } from './subscription.mjs';
import { buildTextDeliverMessage, buildFileDeliverMessage } from './content.mjs';

// upstream: deliver.rs::LONG_TEXT_THRESHOLD
export const LONG_TEXT_THRESHOLD = 500;

// upstream: deliver.rs::is_long_text
export const isLongText = (text) => charCount(text) > LONG_TEXT_THRESHOLD;

// upstream: deliver.rs::is_task_not_found (anyhow `to_string()` = outermost message)
export function isTaskNotFound(err) {
  const s = displayTop(err);
  return s.includes('task not found') || s.includes('code=1001');
}

// upstream: deliver.rs::print_deliver_result — output::to_agent_json of a sorted Value
export function printDeliverResult(outcome, jobId) {
  let v;
  if (outcome.kind === 'Delivered') {
    v = { ok: true, delivered: true, jobId };
    if (outcome.deliveryId !== undefined && outcome.deliveryId !== null) v.deliveryId = outcome.deliveryId;
  } else if (outcome.kind === 'AlreadyDelivered') v = { ok: true, delivered: false, reason: 'alreadyDelivered', jobId, deliveryId: outcome.deliveryId };
  else if (outcome.kind === 'SubscriptionExpired') v = { ok: false, reason: 'subscriptionExpired', jobId, backendCode: outcome.backendCode };
  else v = { ok: false, reason: 'sendFailed', message: outcome.message };
  process.stdout.write(stringify(v, PRETTY) + '\n');
}

const i32 = (v) => (v !== undefined && typeof v === 'number' && v >= -2147483648 && v <= 2147483647 ? v : undefined);

// upstream: deliver.rs::resolve_precondition → { routing, subStatusCode, userAgentId, title, tokenSymbol, tokenAmount }
export async function resolvePrecondition(client, jobId, agentId, nowSecs) {
  let taskResp, taskErr;
  try { taskResp = await client.getWithIdentity(client.taskPath(jobId), agentId); } catch (e) { taskErr = e; }
  if (taskErr === undefined) {
    const statusInt = i32(asI64(at(taskResp, 'status')));
    if (statusInt === undefined) throw new Error('Task detail missing status field, cannot determine delivery eligibility');
    const status = Status.fromInt(statusInt);
    if (status !== Status.Accepted) {
      auditLog('cli', 'ASP/deliver_blocked_wrong_status', false, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `statusInt=${statusInt}`, `status=${Status.asStr(status)}`], 'status != accepted(1)');
      throw new Error(`Deliver rejected: current task status = ${statusInt} (${Status.asStr(status)}), must be accepted (1) before delivery.\n`
        + 'If you just applied, wait for the User Agent to confirm-accept on-chain and receive the `job_accepted` system notification before delivering.\n'
        + "Do NOT call `okx-a2a session send` to rush the User Agent — confirm-accept is a user decision driven by the User Agent's session.");
    }
    const pmInt = i32(asI64(at(taskResp, 'paymentMode'))) ?? 1;
    const pm = PaymentMode.fromInt(pmInt);
    if (pm !== PaymentMode.Escrow) {
      auditLog('cli', 'ASP/deliver_blocked_wrong_payment_mode', false, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `paymentMode=${pmInt}`, `paymentModeStr=${PaymentMode.asStr(pm)}`], 'deliver is escrow-only');
      throw new Error(`Deliver rejected: paymentMode = ${pmInt} (${PaymentMode.asStr(pm)}) — deliver/submit is only supported for escrow (1).\n`
        + "x402 tasks skip the submit step; the User Agent obtains the deliverable by replaying the ASP's endpoint and calls /direct/complete.");
    }
    const jt = at(taskResp, 'jobType');
    const jobType = asI64(jt) ?? (asStr(jt) !== undefined ? parseI64(trim(asStr(jt))) : undefined) ?? 0;
    let routing = Routing.NotSubscription, subStatusCode = 0;
    if (jobType === JOB_TYPE_SUBSCRIBE) {
      const d = await fetchDetail(client, jobId, agentId);
      if (d !== undefined) { routing = d.liveness(nowSecs); subStatusCode = SubStatus.code(d.status); } else routing = Routing.Active;
    }
    return {
      routing, subStatusCode,
      userAgentId: asStr(at(taskResp, 'buyerAgentId')) ?? '',
      title: asStr(at(taskResp, 'title')) ?? '(untitled)',
      tokenSymbol: asStr(at(taskResp, 'tokenSymbol')),
      tokenAmount: asStr(at(taskResp, 'tokenAmount')),
    };
  }
  if (!isTaskNotFound(taskErr)) throw taskErr;
  let raw;
  try { raw = await client.getWithIdentity(client.subscribePath(jobId), agentId); } catch (e2) {
    throw new Error(`job ${jobId} is not a one-shot task, and its subscription detail lookup failed: ${displayTop(e2)}`);
  }
  const d = SubscriptionDetail.fromJson(raw);
  return {
    routing: d.liveness(nowSecs), subStatusCode: SubStatus.code(d.status),
    userAgentId: asStringField(raw, 'buyerAgentId') ?? '',
    title: asStringField(raw, 'title') ?? '(untitled)',
    tokenSymbol: asStringField(raw, 'tokenSymbol'),
    tokenAmount: asStringField(raw, 'serviceTokenAmount') ?? asStringField(raw, 'paymentTokenAmount'),
  };
}

const p2 = (n) => String(n).padStart(2, '0');
// `chrono::Local::now().format("%Y%m%d%H%M%S")`
function localStamp14() {
  const n = localNow();
  return `${String(n.y).padStart(4, '0')}${p2(n.m)}${p2(n.d)}${p2(n.hh)}${p2(n.mm)}${p2(n.ss)}`;
}
// `&job_id[..8]` — byte slice (a non-boundary would panic upstream; practically unreachable)
function shortIdOf(jobId) {
  const buf = Buffer.from(jobId, 'utf8');
  return buf.length > 12 ? `${buf.subarray(0, 8).toString('utf8')}…` : jobId;
}
// `std::env::temp_dir().join(name)` rendered with `Path::display()`: GetTempPath2W / $TMPDIR
// (not Node's TEMP-first os.tmpdir()), joined without normalisation (PathBuf::push).
export function tmpPathFor(name) {
  const dir = rustTempDir();
  const seps = process.platform === 'win32' ? ['\\', '/'] : ['/'];
  return seps.some((s) => dir.endsWith(s)) || dir === '' ? `${dir}${name}` : `${dir}${seps[0]}${name}`;
}

const writeTmpText = (text) => {
  const p = tmpPathFor(`deliverable_${localStamp14()}.txt`);
  try { writeFileSync(p, text); } catch {}
  return p;
};

// upstream: deliver.rs::handle_deliver
export async function handleDeliver(client, jobId, file, deliverableText, agentId) {
  if (agentId === '') throw new Error("--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)");
  if ((file === '') === (deliverableText === '')) throw new Error('Provide exactly one of --file or --deliverable-text');
  const signalDeliveryId = undefined;
  const now = Math.floor(Date.now() / 1000);
  const pre = await resolvePrecondition(client, jobId, agentId, now);
  const { routing, subStatusCode, userAgentId, title, tokenSymbol, tokenAmount } = pre;
  const isSubscription = routing !== Routing.NotSubscription;
  const shortId = shortIdOf(jobId);
  const baseTags = [`jobId=${jobId}`, `agentId=${agentId}`];
  const audit = (event, ok, extra, err) => auditLog('cli', event, ok, 0, [...baseTags, ...extra], err);

  if (routing === Routing.Ended) {
    audit('ASP/deliver_subscription_expired', false, [`subStatus=${subStatusCode}`], 'subscription ended → not delivered; settlement is backend-automatic');
    printDeliverResult({ kind: 'SubscriptionExpired', backendCode: `subStatus=${subStatusCode}` }, jobId);
    return;
  }
  if (userAgentId === '') throw new Error('Deliver rejected: task detail is missing buyerAgentId; A2A delivery cannot be addressed and on-chain submit was not attempted');

  let sendError;
  const send = async (msg, type) => {
    try {
      await xmtpSend(jobId, userAgentId, msg);
      audit('ASP/deliver_a2a_sent', true, [`type=${type}`]);
      return undefined;
    } catch (e) {
      const m = displayTop(e);
      audit('ASP/deliver_a2a_failed', false, [`type=${type}`], m);
      return m;
    }
  };

  let prepared;
  if (file !== '') {
    if (!existsSync(file)) throw new Error(`file not found: ${file}`);
    audit('ASP/deliver_file_upload', true, [`path=${file}`]);
    const upload = await fileUpload(file, agentId, jobId, undefined, undefined);
    audit('ASP/deliver_file_uploaded', true, [`fileKey=${upload.fileKey}`]);
    sendError = await send(buildFileDeliverMessage(jobId, upload), 'file');
    prepared = { kind: 'File', localPath: file, fileKey: upload.fileKey };
  } else {
    const textLen = charCount(deliverableText);
    const isLong = isLongText(deliverableText);
    audit('ASP/deliver_text_prepare', true, [`charCount=${textLen}`, `isLong=${isLong}`]);
    if (isLong) {
      let fileResult;
      try {
        const tmpPath = tmpPathFor(`deliverable_${jobId}.md`);
        writeFileSync(tmpPath, deliverableText);
        const upload = await fileUpload(tmpPath, agentId, jobId, undefined, undefined);
        audit('ASP/deliver_long_text_uploaded', true, [`fileKey=${upload.fileKey}`, `path=${tmpPath}`]);
        const localErr = await send(buildFileDeliverMessage(jobId, upload), 'file_from_long_text');
        fileResult = { ok: [{ kind: 'File', localPath: tmpPath, fileKey: upload.fileKey }, localErr] };
      } catch (e) { fileResult = { err: e }; }
      if (fileResult.ok) {
        [prepared, sendError] = fileResult.ok;
      } else {
        audit('ASP/deliver_long_text_fallback', false, [`charCount=${textLen}`], displayTop(fileResult.err));
        sendError = await send(buildTextDeliverMessage(jobId, deliverableText), 'text_fallback');
        prepared = { kind: 'Text', tmpPath: writeTmpText(deliverableText) };
      }
    } else {
      sendError = await send(buildTextDeliverMessage(jobId, deliverableText), 'text');
      prepared = { kind: 'Text', tmpPath: writeTmpText(deliverableText) };
    }
  }

  if (sendError !== undefined) {
    if (routing === Routing.Active) {
      audit('ASP/deliver_subscription_send_failed', false, [], sendError);
      printDeliverResult({ kind: 'SendFailed', message: sendError }, jobId);
      return;
    }
    audit('ASP/deliver_send_failed_submit_blocked', false, [], sendError);
    throw new Error(`A2A delivery failed; on-chain submit was not attempted: ${sendError}`);
  }

  let txHash;
  if (isSubscription) {
    audit('ASP/deliver_subscription_continued', true, [`subStatus=${subStatusCode}`]);
  } else {
    const [accountId, address] = await resolveWalletByAgentId(agentId);
    const resp = await client.postMutationWithIdentity(client.endpoint(jobId, 'submit'), { evidenceHash: '' }, agentId);
    txHash = await signUopAndBroadcast(client, at(resp, 'uopData'), accountId, address, jobId, extractBizType(resp), agentId, undefined);
    auditLog('cli', 'ASP/deliver_submitted', true, 0, [`jobId=${jobId}`, `agentId=${agentId}`, `txHash=${txHash}`]);
  }

  const localPath = prepared.kind === 'File' ? prepared.localPath : prepared.tmpPath;
  if (existsSync(localPath)) {
    try {
      handleSave({
        jobId, role: 'asp', filePath: localPath, deliverableType: prepared.kind === 'File' ? 'file' : 'text', title, shortId,
        fileKey: prepared.kind === 'File' ? prepared.fileKey : null, tokenSymbol: tokenSymbol ?? null, tokenAmount: tokenAmount ?? null,
        counterpartyAgentId: userAgentId !== '' ? userAgentId : null, counterpartyName: null,
      });
    } catch {}
  }

  if (isSubscription) {
    printDeliverResult({ kind: 'Delivered', deliveryId: signalDeliveryId }, jobId);
    return;
  }
  process.stdout.write('✓ Deliverable submitted; backend confirmation will open the Buyer review\n'
    + `  txHash: ${txHash}\n`
    + '\n'
    + '⚠️  Next steps are driven by system notifications — do not proactively message the User Agent:\n'
    + '    - Wait for `job_completed` or `job_rejected`; ASP-side `job_submitted` is optional and not required for progress\n');
}

