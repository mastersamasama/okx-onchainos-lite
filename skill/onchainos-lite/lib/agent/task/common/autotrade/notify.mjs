// Auto copy-trade user notices pushed by the CLI itself — upstream autotrade/notify.rs.
// Swap outcome notices (`swap execute --notify-job-id`), degrade notices and the bounded
// local notification outbox `<home>/autotrade/notification-outbox/<jobId>/<sha256(key)>.json`.
import { join } from 'node:path';
import { stringify, struct } from '../../../../core/json.mjs';
import { jobIdIsSafe } from './grants.mjs';
import { DegradeReason } from './index.mjs';
import { fromSlice, T } from './_serde-json.mjs';
import { onchainosHome, exists, isDir, readBytes, readDirPaths, writeSecure, removeFileQuiet, renameQuiet, extension, withExtension,
  ageSecs, nowSecs, satAdd, u64Gt, sha256Hex } from './_fs.mjs';
import { resolve as resolveLang, Lang } from '../user-lang.mjs';
import { userNotifyScoped, userNotifyScopedWithTimeout } from '../okx-a2a.mjs';
import { splitWhitespace, get, asStr, asciiLower } from '../../../_rs.mjs';
import { asciiUpper } from '../../../../core/_rust-str.mjs';

const NOTICE_VERSION = 1;
const MAX_FLUSH_BATCH = 4;
const MAX_NOTIFICATION_ATTEMPTS = 10;
const STALE_LEASE_SEC = 30;

// upstream: notify.rs::PendingNotice (deny_unknown_fields)
const PENDING_NOTICE_T = T.struct('PendingNotice', [
  ['version', T.u32], ['jobId', T.string], ['idempotencyKey', T.string], ['content', T.string],
  ['attempts', T.u32], ['nextAttemptAt', T.u64], ['createdAt', T.u64], ['updatedAt', T.u64],
], { denyUnknown: true });
const pendingNoticeJson = (n) => struct({
  version: n.version, jobId: n.jobId, idempotencyKey: n.idempotencyKey, content: n.content,
  attempts: n.attempts, nextAttemptAt: n.nextAttemptAt, createdAt: n.createdAt, updatedAt: n.updatedAt,
});
const readNotice = (path) => { try { return fromSlice(readBytes(path), PENDING_NOTICE_T); } catch { return undefined; } };
const backoff = (attempts) => Math.min(30 * 2 ** Math.min(attempts, 5), 15 * 60);

// upstream: notify.rs::outbox_root / notice_path
const outboxRoot = () => join(onchainosHome(), 'autotrade', 'notification-outbox');
function noticePath(jobId, idempotencyKey) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  return join(outboxRoot(), jobId, `${sha256Hex(idempotencyKey)}.json`);
}

// upstream: notify.rs::persist_failed_notice
function persistFailedNotice(jobId, idempotencyKey, content, previousAttempts) {
  const path = noticePath(jobId, idempotencyKey);
  const now = nowSecs();
  const attempts = previousAttempts + 1;
  const createdAt = readNotice(path)?.createdAt ?? now;
  writeSecure(path, stringify(pendingNoticeJson({
    version: NOTICE_VERSION, jobId, idempotencyKey, content, attempts, nextAttemptAt: satAdd(now, backoff(attempts)), createdAt, updatedAt: now,
  }), true));
}

// upstream: notify.rs::deliver_pending → delivered?
async function deliverPending(path, notice, force, timeoutMs) {
  if (notice.version !== NOTICE_VERSION || !jobIdIsSafe(notice.jobId)) throw new Error('invalid pending notification record');
  if (!force && u64Gt(notice.nextAttemptAt, nowSecs())) return false;
  let ok = true;
  try {
    if (timeoutMs !== undefined) await userNotifyScopedWithTimeout(notice.content, notice.jobId, notice.idempotencyKey, timeoutMs);
    else await userNotifyScoped(notice.content, notice.jobId, notice.idempotencyKey);
  } catch { ok = false; }
  if (ok) { removeFileQuiet(path); return true; }
  notice.attempts = Math.min(notice.attempts + 1, 4294967295);
  notice.updatedAt = nowSecs();
  if (notice.attempts >= MAX_NOTIFICATION_ATTEMPTS) { removeFileQuiet(path); return false; }
  notice.nextAttemptAt = satAdd(notice.updatedAt, backoff(notice.attempts));
  writeSecure(path, stringify(pendingNoticeJson(notice), true));
  return false;
}

const byNextAttempt = (a, b) => { const x = BigInt(a[1].nextAttemptAt), y = BigInt(b[1].nextAttemptAt); return x < y ? -1 : x > y ? 1 : 0; };

// upstream: notify.rs::flush_pending → delivered count
export async function flushPending(jobId, force) {
  if (!jobIdIsSafe(jobId)) throw new Error('invalid job id');
  const directory = join(outboxRoot(), jobId);
  if (!isDir(directory)) return 0;
  const pending = [];
  for (const path of readDirPaths(directory)) {
    if (extension(path) !== 'json') continue;
    const notice = readNotice(path);
    if (notice === undefined) continue;
    if (notice.jobId === jobId) pending.push([path, notice]);
  }
  pending.sort(byNextAttempt);
  let delivered = 0;
  for (const [path, notice] of pending.slice(0, MAX_FLUSH_BATCH)) delivered += (await deliverPending(path, notice, force, undefined)) ? 1 : 0;
  return delivered;
}

// upstream: notify.rs::flush_all_pending_bounded → delivered count
export async function flushAllPendingBounded(limit, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const root = outboxRoot();
  if (!isDir(root)) return 0;
  const pending = [];
  for (const dir of readDirPaths(root)) {
    if (!isDir(dir)) continue;
    for (const path of readDirPaths(dir)) {
      const ext = extension(path);
      if (ext !== undefined && ext.startsWith('lease-')) {
        const age = ageSecs(path);
        if (age !== undefined && age >= STALE_LEASE_SEC) {
          const original = withExtension(path, 'json');
          if (exists(original)) removeFileQuiet(path); else renameQuiet(path, original);
        }
        continue;
      }
      if (ext !== 'json') continue;
      const notice = readNotice(path);
      if (notice !== undefined) pending.push([path, notice]);
    }
  }
  pending.sort(byNextAttempt);
  let delivered = 0;
  for (const [path, notice] of pending.slice(0, Math.max(limit, 1))) {
    const remaining = deadline - Date.now();
    if (remaining < 25) break;
    const lease = withExtension(path, `lease-${process.pid}`);
    if (!renameQuiet(path, lease)) continue;
    let result = false;
    try { result = await deliverPending(lease, notice, false, remaining); } catch { result = false; }
    if (exists(lease)) {
      if (exists(path)) removeFileQuiet(lease); else renameQuiet(lease, path);
    }
    delivered += result ? 1 : 0;
  }
  return delivered;
}

// upstream: notify.rs::short_id
export function shortId(s) {
  const c = [...String(s)];
  return c.length > 16 ? `${c.slice(0, 6).join('')}…${c.slice(-4).join('')}` : String(s);
}
// upstream: notify.rs::flatten_reason
export function flattenReason(raw) {
  let one = splitWhitespace(raw).join(' ');
  const c = [...one];
  if (c.length > 300) one = c.slice(0, 300).join('') + '…';
  return one;
}

// upstream: notify.rs::success_message
function successMessage(t, txHash, orderId, cap, autoMode, lang) {
  const job = shortId(t.jobId);
  const en = lang === Lang.En;
  const result = en
    ? (txHash !== '' ? `Tx: ${txHash}` : orderId !== '' ? `Order: ${orderId}` : 'submitted — check wallet history for the tx id')
    : (txHash !== '' ? `交易哈希: ${txHash}` : orderId !== '' ? `订单号: ${orderId}` : '已提交,交易 ID 可稍后在交易历史中查询');
  const executed = en ? (autoMode ? 'dex signal auto-executed' : 'dex signal executed (per your confirmation)')
    : (autoMode ? 'dex 信号已自动执行' : 'dex 信号已执行(经你确认)');
  let s = en
    ? `[Auto Copy-Trade] Job ${job}: ${executed} — swap ${t.amount} ${t.from} → ${t.to} on ${t.chain}. ${result}`
    : `[自动跟单] 任务 ${job}:${executed} — ${t.chain} 链 swap ${t.amount} ${t.from} → ${t.to}。${result}`;
  if (cap !== undefined) {
    s += en ? `\nWithin your ${cap} per-trade auto limit. Reply "Pause auto copy-trading" to turn it off anytime.`
      : `\n本次在你的每笔 ${cap} 自动限额内。回复「暂停自动跟单」可随时关闭。`;
  }
  return s;
}
// upstream: notify.rs::failure_message
function failureMessage(t, reason, lang) {
  const job = shortId(t.jobId);
  return lang === Lang.En
    ? `[Auto Copy-Trade] Job ${job}: auto-execution FAILED — swap ${t.amount} ${t.from} → ${t.to} on ${t.chain} did not complete. Reason: ${reason}\nYou can run this trade manually; auto copy-trade will not retry it.`
    : `[自动跟单] 任务 ${job}:自动执行失败 — ${t.chain} 链 swap ${t.amount} ${t.from} → ${t.to} 未完成。原因: ${reason}\n可手动补做,系统不会自动重试。`;
}
// upstream: notify.rs::token_symbol
const tokenSymbol = (token) => { const s = asStr(get(token, 'tokenSymbol')); return s !== undefined && s !== '' ? s : undefined; };

// upstream: notify.rs::notify_swap_outcome — outcome = { ok: data } | { err: Error }. Infallible.
export async function notifySwapOutcome(jobId, chain, displayAmount, fromArg, toArg, outcome) {
  const { loadConsent, ConsentMode, QUOTE_WHITELIST } = await import('./consent.mjs');
  const lang = resolveLang(jobId);
  const fromShort = shortId(fromArg);
  const toShort = shortId(toArg);
  let msg;
  if (outcome && Object.prototype.hasOwnProperty.call(outcome, 'ok')) {
    const out = outcome.ok;
    const t = { jobId, chain, amount: displayAmount, from: tokenSymbol(get(out, 'fromToken')) ?? fromShort, to: tokenSymbol(get(out, 'toToken')) ?? toShort };
    const tx = asStr(get(out, 'swapTxHash')) ?? '';
    const order = asStr(get(out, 'swapOrderId')) ?? '';
    let consent = null;
    try { consent = loadConsent(jobId); } catch { consent = null; }
    const autoMode = consent ? consent.mode === ConsentMode.Auto : false;
    const fromIsQuote = QUOTE_WHITELIST.includes(asciiLower(fromArg));
    const cap = autoMode && fromIsQuote && consent.capU !== null && consent.capU !== undefined ? `${consent.capU} ${asciiUpper(fromArg)}` : undefined;
    msg = successMessage(t, tx, order, cap, autoMode, lang);
  } else {
    const e = outcome?.err;
    const t = { jobId, chain, amount: displayAmount, from: fromShort, to: toShort };
    msg = failureMessage(t, flattenReason(String(e?.message ?? e)), lang);
  }
  const key = `autotrade-swap:${sha256Hex(`${jobId}\0${msg}`)}`;
  try { await userNotifyScoped(msg, jobId, key); } catch (e) {
    process.stderr.write(`[autotrade] outcome notification failed (non-fatal): ${e.message}\n`);
  }
}

// upstream: notify.rs::degrade_message
function degradeMessage(jobId, reason, lang) {
  const job = shortId(jobId);
  if (reason === DegradeReason.MultipleTakeProfitUnsupported) {
    return lang === Lang.En
      ? `[Auto Copy-Trade] The provider's signal for job ${job} contains multiple take-profit levels. The current version supports only one, so this trade was not executed. The deliverable is saved for manual review.`
      : `[自动跟单] 任务 ${job}:服务商信号包含多个止盈目标,当前版本仅支持单个止盈目标,因此本次未自动执行。交付物已保存,可手动查看处理。`;
  }
  return lang === Lang.En
    ? `[Auto Copy-Trade] The provider's signal for job ${job} was not executed (${reason}). The deliverable is saved for manual review.`
    : `[自动跟单] 任务 ${job}:服务商信号未执行(原因: ${reason})。交付物已保存,可手动查看处理。`;
}

// upstream: notify.rs::push_degrade_notice — mutates a card.NotifyOnly object (camelCase fields).
export async function pushDegradeNotice(n, jobId) {
  if (n.reason === DegradeReason.ReplaySkip) {
    n.notificationPushed = true;
    n.notificationTemplate = '';
    n.guidance = 'Duplicate of an already-executed signal — deliberately absorbed. Do NOT notify the user; just end the turn.';
    return;
  }
  const lang = resolveLang(jobId);
  const msg = degradeMessage(jobId, n.reason, lang);
  const key = `autotrade-degrade:${sha256Hex(`${jobId}\0${n.reason}`)}`;
  let delivered = false, lastError;
  for (let i = 0; i < 3; i++) {
    try {
      await userNotifyScoped(msg, jobId, key);
      delivered = true;
      try { removeFileQuiet(noticePath(jobId, key)); } catch {}
      break;
    } catch (e) { lastError = e; }
  }
  if (delivered) {
    n.notificationPushed = true;
    n.notificationTemplate = '';
    n.guidance = 'The CLI already delivered this degrade notice to the user — do NOT run `onchainos agent user-notify` again; just end the turn.';
    return;
  }
  let persisted = true;
  try { persistFailedNotice(jobId, key, msg, 2); } catch { persisted = false; }
  process.stderr.write(`[autotrade] degrade notification failed (non-fatal, persisted=${persisted}): ${lastError ? lastError.message : 'unknown error'}\n`);
  n.guidance = persisted
    ? 'CLI push failed, but the notice is persisted in the local outbox for bounded retry. Do not execute a trade; the agent may also use the notification template as an immediate fallback.'
    : 'CLI push and outbox persistence failed — deliver this degrade notice yourself: fill `notificationTemplate` with `reason` (localized) and push it via `onchainos agent user-notify`.';
}
