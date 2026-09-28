// PRIVATE fallback for upstream agent_commerce/task/common/autotrade/notify.rs::notify_swap_outcome
// (owner: lib/agent/task/common/autotrade/notify.mjs, not ported yet). When the owner module
// exists and exports notifySwapOutcome it is used; otherwise this port runs. It is infallible
// by design: the swap result is never masked by a reporting error (stderr line only).
// Known gap of the fallback: the per-job consent file (autotrade/consent.rs) is not read, so
// the "auto-executed" wording and the per-trade cap line of Auto-consent jobs are not rendered.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { homePath } from '../../core/home.mjs';
import { F64 } from '../../core/json.mjs';
import { trim } from '../../core/_rust-str.mjs';

const NOTIFY_TIMEOUT_MS = 5000;   // okx_a2a.rs::user_notify_scoped → Duration::from_secs(5)

async function ownerFn() {
  const url = new URL('../../agent/task/common/autotrade/notify.mjs', import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  // notify_swap_outcome is infallible upstream: a broken owner module must not turn an already
  // printed swap result into a crash — fall back to the local port instead.
  try {
    const m = await import(url.href);
    return typeof m.notifySwapOutcome === 'function' ? m.notifySwapOutcome : null;
  } catch { return null; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
const str = (v, k) => (isObj(v) && typeof v[k] === 'string' ? v[k] : undefined);

// upstream: user_lang.rs::resolve — per-job marker → machine-global `_default` → En.
function resolveLang(jobId) {
  const read = (name) => {
    try {
      // fs::read_to_string fails on invalid UTF-8 (→ None); str::trim is Unicode White_Space.
      const t = trim(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(homePath('autotrade', 'lang', name))));
      return t === 'zh' || t === 'en' ? t : undefined;
    } catch { return undefined; }
  };
  if (jobId !== '' && /^[A-Za-z0-9_-]+$/.test(jobId)) {
    const l = read(jobId);
    if (l) return l;
  }
  return read('_default') ?? 'en';
}

// upstream: notify.rs::short_id — char-based `0xabcd…1234` for values longer than 16 chars.
export function shortId(s) {
  const chars = [...s];
  return chars.length > 16 ? `${chars.slice(0, 6).join('')}…${chars.slice(-4).join('')}` : s;
}

// str::split_whitespace separators: Unicode White_Space (char::is_whitespace) — unlike JS `\s`
// this includes U+0085 and excludes U+FEFF.
const RUST_WS = new RegExp('[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', 'u');

// upstream: notify.rs::flatten_reason — whitespace-collapsed, at most 300 chars + '…'.
export function flattenReason(raw) {
  let one = raw.split(RUST_WS).filter(Boolean).join(' ');
  const chars = [...one];
  if (chars.length > 300) one = chars.slice(0, 300).join('') + '…';
  return one;
}

// upstream: notify.rs::success_message (cap = None; auto_mode from consent)
function successMessage(t, txHash, orderId, autoMode, lang) {
  const job = shortId(t.jobId);
  const en = lang === 'en';
  const result = en
    ? (txHash !== '' ? `Tx: ${txHash}` : orderId !== '' ? `Order: ${orderId}` : 'submitted — check wallet history for the tx id')
    : (txHash !== '' ? `交易哈希: ${txHash}` : orderId !== '' ? `订单号: ${orderId}` : '已提交,交易 ID 可稍后在交易历史中查询');
  const executed = en
    ? (autoMode ? 'dex signal auto-executed' : 'dex signal executed (per your confirmation)')
    : (autoMode ? 'dex 信号已自动执行' : 'dex 信号已执行(经你确认)');
  return en
    ? `[Auto Copy-Trade] Job ${job}: ${executed} — swap ${t.amount} ${t.from} → ${t.to} on ${t.chain}. ${result}`
    : `[自动跟单] 任务 ${job}:${executed} — ${t.chain} 链 swap ${t.amount} ${t.from} → ${t.to}。${result}`;
}

// upstream: notify.rs::failure_message
function failureMessage(t, reason, lang) {
  const job = shortId(t.jobId);
  return lang === 'en'
    ? `[Auto Copy-Trade] Job ${job}: auto-execution FAILED — swap ${t.amount} ${t.from} → ${t.to} on ${t.chain} did not complete. Reason: ${reason}\nYou can run this trade manually; auto copy-trade will not retry it.`
    : `[自动跟单] 任务 ${job}:自动执行失败 — ${t.chain} 链 swap ${t.amount} ${t.from} → ${t.to} 未完成。原因: ${reason}\n可手动补做,系统不会自动重试。`;
}

// std::io::Error Display for the spawn failures a missing / unusable `okx-a2a` produces.
function spawnErrorText(err) {
  if (err.code === 'ETIMEDOUT') return `okx-a2a command timed out after ${NOTIFY_TIMEOUT_MS / 1000}s`;
  const win = process.platform === 'win32';
  if (err.code === 'ENOENT') return win ? 'program not found' : 'No such file or directory (os error 2)';
  if (err.code === 'EACCES' || err.code === 'EPERM') return win ? 'Access is denied. (os error 5)' : 'Permission denied (os error 13)';
  return err.message;
}

// std::process::ExitStatus Display: Windows "exit code: N" (hex when the high bit is set),
// Unix "exit status: N" or "signal: N (SIGNAME)".
export function exitStatusText(status, signal, platform = process.platform) {
  if (platform === 'win32') {
    const code = status >>> 0;
    return code & 0x80000000 ? `exit code: 0x${code.toString(16)}` : `exit code: ${code}`;
  }
  if (status !== null && status !== undefined) return `exit status: ${status}`;
  const num = osConstants.signals[signal];
  return num === undefined ? `signal: ${signal}` : `signal: ${num} (${signal})`;
}

// upstream: okx_a2a.rs::user_notify_scoped (compose_user_notify_content + `okx-a2a user notify`).
function userNotifyScoped(content, jobId, idempotencyKey) {
  const text = content.replaceAll('\\n', '\n');
  if (text.includes('file://') || (text.includes('![') && text.includes(']('))) {
    throw new Error('local image links in --content are not supported; use --image-path <file>');
  }
  const r = spawnSync('okx-a2a', ['user', 'notify', '--content', text, '--job-id', jobId, '--idempotency-key', idempotencyKey, '--json'],
    { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' });
  if (r.error) throw new Error(`scoped user notify failed: ${spawnErrorText(r.error)}`);
  if (r.status !== 0) {
    throw new Error(`okx-a2a scoped user notify exit ${exitStatusText(r.status, r.signal)}: ${r.stderr ?? ''}`);
  }
}

// upstream: notify.rs::notify_swap_outcome — outcome = { ok: data } | { err: Error }.
export async function notifySwapOutcome(jobId, chain, displayAmount, fromArg, toArg, outcome) {
  const owner = await ownerFn();
  if (owner) return owner(jobId, chain, displayAmount, fromArg, toArg, outcome);
  const lang = resolveLang(jobId);
  const fromShort = shortId(fromArg);
  const toShort = shortId(toArg);
  let msg;
  if ('ok' in outcome) {
    const out = outcome.ok;
    const sym = (k) => { const s = str(isObj(out) ? out[k] : undefined, 'tokenSymbol'); return s ? s : undefined; };
    const t = { jobId, chain, amount: displayAmount, from: sym('fromToken') ?? fromShort, to: sym('toToken') ?? toShort };
    msg = successMessage(t, str(out, 'swapTxHash') ?? '', str(out, 'swapOrderId') ?? '', false, lang);
  } else {
    const e = outcome.err;
    const t = { jobId, chain, amount: displayAmount, from: fromShort, to: toShort };
    msg = failureMessage(t, flattenReason(String(e?.message ?? e)), lang);
  }
  const idempotencyKey = `autotrade-swap:${createHash('sha256').update(`${jobId}\0${msg}`).digest('hex')}`;
  try {
    userNotifyScoped(msg, jobId, idempotencyKey);
  } catch (e) {
    process.stderr.write(`[autotrade] outcome notification failed (non-fatal): ${e.message}\n`);
  }
}
