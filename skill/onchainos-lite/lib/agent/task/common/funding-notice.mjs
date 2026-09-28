// Funding notice — upstream task/common/funding_notice.rs.
import { buildQrOutput, displayMode as qrDisplayMode } from '../../../core/qr.mjs';
import { stringify } from '../../../core/json.mjs';
import { at, asStr, trim } from '../../_rs.mjs';
import { userNotify } from './okx-a2a.mjs';

// upstream: funding_notice.rs::funding_display_mode
export const fundingDisplayMode = () => qrDisplayMode();

// upstream: funding_notice.rs::funding_notice_command
export function fundingNoticeCommand(warning, reason) {
  const chain = asStr(at(warning, 'chain')) ?? 'XLayer';
  const currency = asStr(at(warning, 'currency'));
  const shortfall = asStr(at(warning, 'shortfall'));
  const depositAddress = asStr(at(warning, 'depositAddress'));
  if (currency === undefined || shortfall === undefined || depositAddress === undefined) return undefined;
  const parts = ['onchainos', 'agent', 'funding-notice', '--chain', chain, '--currency', currency, '--shortfall', shortfall, '--deposit-address', depositAddress];
  for (const [flag, key] of [['--available', 'available'], ['--required', 'required'], ['--deposit-chain', 'depositChain']]) {
    const v = asStr(at(warning, key));
    if (v !== undefined && v !== '') parts.push(flag, v);
  }
  parts.push('--reason', reason, '--format', 'json');
  return parts.join(' ');
}

// upstream: funding_notice.rs::funding_blocked_envelope (json! → sorted)
export function fundingBlockedEnvelope(warning, reason, action) {
  const cmd = fundingNoticeCommand(warning, reason);
  const must = cmd !== undefined;
  const mode = fundingDisplayMode();
  const imageNotify = must && mode === 'image-notify';
  return {
    blocked: true, blockedReason: 'insufficient-balance', submitted: false, balanceWarning: warning,
    mustRunFundingNotice: must, fundingNoticeCommand: cmd ?? null, fundingDisplayMode: mode,
    mustRunNotifyCommand: imageNotify, mustRenderMarkdownImageBelowFirstOption: imageNotify,
    mustRepeatInFinalResponse: true, forbidFundingSummary: true,
    finalResponsePolicy: 'Final response must repeat the full localized funding notice with all four funding options; put markdownImage under option 1 when present; never summarize.',
    platformPolicy: !must ? 'Funding notice unavailable: show balanceWarning, explain deposit address is missing, then end turn.'
      : imageNotify ? 'Non-TTY: run fundingNoticeCommand, then notifyCommandArgs for PNG QR, then put markdownImage under option 1 in final.'
        : 'TTY: run fundingNoticeCommand, show terminalQr and full notice; do not claim PNG was sent.',
    resumeAction: 'After the user says topped up, re-enter the owning Reference and run its fresh read-only balance or prepare check. Never rerun a saved write command directly.',
    guidance: must ? `${action} was blocked by insufficient balance. Save the current business context. Run fundingNoticeCommand, then follow its displayMode. End turn.`
      : `${action} was blocked by insufficient balance. Save the current business context. Show balanceWarning and missing deposit address. End turn.`,
  };
}

function requiredArg(name, value) {
  const t = trim(value);
  if (t === '') throw new Error(`${name} must not be empty`);
  return t;
}

// upstream: FundingNoticeInput::try_from(FundingNoticeArgs) (throws the anyhow text)
export function fundingNoticeInput(args) {
  const chain = requiredArg('--chain', args.chain);
  const currency = requiredArg('--currency', args.currency);
  const shortfall = requiredArg('--shortfall', args.shortfall);
  const depositAddress = requiredArg('--deposit-address', args.depositAddress);
  if (args.notifyUser && (args.content === undefined || args.content === null || trim(args.content) === '')) {
    throw new Error('--notify-user requires --content with already-localized text');
  }
  const depositChain = args.depositChain === undefined || args.depositChain === null ? chain : requiredArg('--deposit-chain', args.depositChain);
  return { chain, currency, shortfall, depositAddress, required: args.required ?? null, available: args.available ?? null, depositChain,
    reason: args.reason, imageDir: args.imageDir ?? null };
}

const isXLayer = (chain) => [...chain].filter((c) => /[0-9A-Za-z]/.test(c)).join('').toLowerCase() === 'xlayer';
const gasLine = (i) => (isXLayer(i.chain) || isXLayer(i.depositChain) ? 'On-chain gas on X Layer is free after the funds arrive.' : 'Ensure the wallet meets the network gas requirements.');

// upstream: funding_notice.rs::render_content
export function renderContent(i) {
  const lines = [`Insufficient ${i.currency} balance on ${i.chain}: shortfall ${i.shortfall} ${i.currency}.`];
  if (i.available !== null) lines.push(`Available: ${i.available} ${i.currency}.`);
  if (i.required !== null) lines.push(`Required: ${i.required} ${i.currency}.`);
  lines.push('', `Deposit address: ${i.depositAddress}`, `Deposit network: ${i.depositChain}`, '', 'Funding options:',
    `1. Scan and deposit — send ${i.currency} directly to the address above on ${i.depositChain}.`,
    `2. Swap — swap <token> to ${i.shortfall} ${i.currency} on ${i.chain}.`,
    `3. Bridge — bridge ${i.shortfall} ${i.currency} from <chain> to ${i.chain}.`,
    `4. Withdraw from OKX — withdraw ${i.currency} to the address above using the ${i.depositChain} network. The exchange may charge a withdrawal fee.`,
    '', gasLine(i), '', 'After topping up, tell me "I topped up".');
  return lines.join('\n');
}

// upstream: funding_notice.rs::render_fallback_content
export const renderFallbackContent = (i) => `QR image could not be attached. Deposit ${i.currency} to ${i.depositAddress} on ${i.depositChain}. After topping up, tell me "I topped up".`;

const shellQuote = (v) => `'${String(v).split("'").join("'\\''")}'`;

// upstream: funding_notice.rs::build_funding_notice_from_qr → [notice (Value, sorted), imagePath | null]
export function buildFundingNoticeFromQr(i, qr) {
  const imagePath = qr.imagePath ?? null;
  const imageNotify = imagePath !== null;
  const notice = {
    contentCanonical: renderContent(i), fallbackContentCanonical: renderFallbackContent(i), imagePath, markdownImage: qr.markdownImage ?? null,
    terminalQr: qr.terminalQr ?? null, displayMode: qr.displayMode, depositAddress: i.depositAddress, chain: i.chain, depositChain: i.depositChain,
    currency: i.currency, shortfall: i.shortfall, required: i.required, available: i.available, reason: i.reason,
    mustLocalize: true, mustNotifyWithImagePath: imageNotify, mustRunNotifyCommand: imageNotify, mustRenderMarkdownImageBelowFirstOption: imageNotify,
    mustRepeatInFinalResponse: true, forbidFundingSummary: true,
    displayPolicy: imageNotify ? 'Non-TTY: run notifyCommandArgs for PNG QR, put markdownImage under option 1, then repeat the full localized notice in final; never summarize.'
      : 'TTY: show terminalQr and the full localized notice; never summarize or claim PNG was sent.',
    endTurn: true,
    notifyCommand: imageNotify ? `onchainos agent user-notify --content "$ONCHAINOS_FUNDING_NOTICE_CONTENT" --image-path ${shellQuote(imagePath)}` : null,
    notifyCommandArgs: qr.notifyCommandArgs ?? null,
  };
  return [notice, imagePath];
}

// upstream: funding_notice.rs::execute(args) — prints the pretty JSON notice (or `OK` with --notify-user).
// args: { chain, currency, shortfall, depositAddress, required, available, depositChain, reason, format, notifyUser, content, imageDir }
export async function execute(args) {
  const input = fundingNoticeInput(args);
  const qr = buildQrOutput(input.depositAddress, input.imageDir);
  const [notice, imagePath] = buildFundingNoticeFromQr(input, qr);
  if (args.notifyUser) {
    if (imagePath === null) throw new Error('--notify-user requires an image-notify display path');
    await userNotify(args.content, imagePath, true);
    return;
  }
  process.stdout.write(stringify({ ok: true, data: notice }, true) + '\n');
}
