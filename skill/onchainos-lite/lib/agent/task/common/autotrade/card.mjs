// Notify-only / decision payloads — upstream autotrade/card.rs (live parts).
// The retired execution-card recipe assembly (assemble_command / dex_command / defi_command /
// polymarket_command / make_execution_card, built on the retired schema.rs) has no production
// caller in 4.6.3 and is not ported.
import { struct } from '../../../../core/json.mjs';
import { resolve as resolveLang, Lang } from '../user-lang.mjs';
import { loadDeliveryContext, deliveryDecisionSummary, pendingDeliveryDecisionSummary, quoteToken } from './consent.mjs';
import { asciiUpper } from '../../../../core/_rust-str.mjs';
import { ExecutionTool } from './tooling.mjs';

const NOTIFY_TEMPLATE = "[Auto Copy-Trade] The provider's signal for job <jobId> was not executed (<reason>). The deliverable is saved for manual review and may still be executed manually with any available tool.";

// upstream: card.rs::NotifyOnly → serde Serialize (struct order + skip rules)
export function notifyOnlyJson(n) {
  return struct({
    autoTrade: n.autoTrade, executed: n.executed, savedPath: n.savedPath, reason: n.reason,
    notificationTemplate: n.notificationTemplate === '' ? undefined : n.notificationTemplate,
    notificationPushed: n.notificationPushed ? true : undefined,
    guidance: n.guidance === '' ? undefined : n.guidance,
  });
}
// upstream: card.rs::make_notify_only → mutable NotifyOnly record
export function makeNotifyOnly(savedPath, reason) {
  return { autoTrade: true, executed: false, savedPath, reason, notificationTemplate: NOTIFY_TEMPLATE, notificationPushed: false, guidance: '' };
}

// upstream: card.rs source events
export const CONSENT_SOURCE_EVENT = 'autotrade_consent';
export const CONFIG_REQUIRED_SOURCE_EVENT = 'autotrade_config_required';
export const MANUAL_SOURCE_EVENT = 'autotrade_manual_signal';
export const OVER_CAP_SOURCE_EVENT = 'autotrade_over_cap';
export const TOOL_SELECT_SOURCE_EVENT = 'autotrade_tool_select';
export const CAP_ADJUST_SOURCE_EVENT = 'autotrade_cap_adjust';
export const PLUGIN_INSTALL_SOURCE_EVENT = 'autotrade_plugin_install';

const DECISION_GUIDANCE = "Do NOT execute any trade and do NOT read the deliverable. 🌐 `userContent` is already rendered in the user's language (per-job language marker) — put it into the command's --user-content verbatim; do NOT re-translate or reword it, and never change the option letters or any number. Then run the command to push the decision. Act on the trade only after the user answers.";

// upstream: card.rs::DecisionRequest → serde Serialize (struct order)
export function decisionRequestJson(d) {
  return struct({
    autoTrade: d.autoTrade, executed: d.executed, decision: d.decision, deliveryId: d.deliveryId, signalType: d.signalType,
    jobId: d.jobId, sourceEvent: d.sourceEvent, userContent: d.userContent, command: d.command, guidance: d.guidance,
    requiresPlugin: d.requiresPlugin === null || d.requiresPlugin === undefined ? undefined : d.requiresPlugin,
  });
}

// upstream: card.rs::consent_list_label / plugin_list_label
const consentListLabel = (signalType) => `[Auto Copy-Trade consent] ${signalType}`;
const pluginListLabel = (plugin) => `[Auto Copy-Trade plugin] ${plugin}`;

// upstream: card.rs::decision_list_label
export function decisionListLabel(d) {
  if (d.sourceEvent === TOOL_SELECT_SOURCE_EVENT) return `[Auto Copy-Trade venue] ${d.signalType}`;
  if (d.sourceEvent === CAP_ADJUST_SOURCE_EVENT) return `[Auto Copy-Trade cap] ${d.signalType}`;
  return d.requiresPlugin !== null && d.requiresPlugin !== undefined ? pluginListLabel(d.requiresPlugin) : consentListLabel(d.signalType);
}
// upstream: card.rs::non_plugin_list_label
function nonPluginListLabel(sourceEvent, signalType) {
  if (sourceEvent === TOOL_SELECT_SOURCE_EVENT) return `[Auto Copy-Trade venue] ${signalType}`;
  if (sourceEvent === CAP_ADJUST_SOURCE_EVENT) return `[Auto Copy-Trade cap] ${signalType}`;
  return consentListLabel(signalType);
}
// upstream: card.rs::decision_command
function decisionCommand(jobId, agentId, signalType, sourceEvent) {
  return `onchainos agent pending-decisions-v2 request --job-id ${jobId} --role user --agent-id ${agentId} --source-event ${sourceEvent} --list-label "${nonPluginListLabel(sourceEvent, signalType)}" --user-content "<userContent verbatim — already in the user's language>"`;
}

// upstream: card.rs::make_decision
function makeDecision(deliveryId, signalType, jobId, agentId, sourceEvent, userContent) {
  const lang = resolveLang(jobId);
  let summary;
  try { summary = deliveryDecisionSummary(loadDeliveryContext(jobId, deliveryId), lang); } catch { summary = undefined; }
  if (summary === undefined) summary = pendingDeliveryDecisionSummary(jobId, lang);
  return {
    autoTrade: true, executed: false, decision: true, deliveryId, signalType, jobId, sourceEvent,
    userContent: summary !== undefined ? `${summary}\n\n${userContent}` : userContent,
    command: decisionCommand(jobId, agentId, signalType, sourceEvent), guidance: DECISION_GUIDANCE, requiresPlugin: null,
  };
}

// upstream: card.rs::make_tool_select_decision (tools: ExecutionTool tokens from tooling.mjs)
export function makeToolSelectDecision(deliveryId, signalType, jobId, agentId, tools) {
  const letter = (i) => String.fromCharCode(65 + i);
  let choices = tools.map((t, i) => `  ${letter(i)}. ${ExecutionTool.displayName(t)} (\`${ExecutionTool.token(t)}\`)`).join('\n');
  const skip = letter(tools.length);
  const zh = resolveLang(jobId) === Lang.Zh;
  choices += zh ? `\n  ${skip}. 跳过自动执行;保留已保存的交付物,稍后可用任意可用工具手动处理`
    : `\n  ${skip}. Skip automatic execution; keep the saved deliverable for manual handling with any available tool`;
  const lead = zh ? '[请确认] 当前信号有多个可用执行工具,请选择一次,后续该订阅沿用:'
    : '[Confirmation Needed] More than one compatible execution tool is available. Choose once for this subscription:';
  return makeDecision(deliveryId, signalType, jobId, agentId, TOOL_SELECT_SOURCE_EVENT, `${lead}\n${choices}`);
}

// upstream: card.rs::make_cap_adjust_decision
export function makeCapAdjustDecision(signalType, jobId, agentId, amountU, capU) {
  const content = resolveLang(jobId) === Lang.Zh
    ? `[请确认] 本次 ${amountU} U 交易已成功。是否把后续每笔上限从 ${capU} U 调整为 ${amountU} U?\n  A. 调高\n  B. 保持原上限`
    : `[Decision] This ${amountU} U trade succeeded. Raise the future per-trade limit from ${capU} U to ${amountU} U?\n  A. Raise it\n  B. Keep the current limit`;
  return makeDecision('cap_adjust', signalType, jobId, agentId, CAP_ADJUST_SOURCE_EVENT, content);
}

// upstream: card.rs::make_manual_signal_decision
export function makeManualSignalDecision(deliveryId, signalType, jobId, agentId, amount) {
  const zh = resolveLang(jobId) === Lang.Zh;
  const a = amount !== null && amount !== undefined && amount !== ''
    ? (zh ? `，当前金额 ${amount} ${asciiUpper(quoteToken(jobId))}` : `, current amount ${amount} ${asciiUpper(quoteToken(jobId))}`) : '';
  const content = zh
    ? `[请确认] 收到一条交易信号，该订阅当前为逐笔手动确认模式${a}。请选择:\n  A. 执行本次交易\n  B. 跳过本次交易`
    : `[Confirmation Needed] A trading signal arrived and this subscription is in per-signal manual mode${a}. Choose:\n  A. Execute this trade\n  B. Skip this trade`;
  return makeDecision(deliveryId, signalType, jobId, agentId, MANUAL_SOURCE_EVENT, content);
}

// upstream: card.rs::consent_input_required_content
function consentInputRequiredContent(mode, lang) {
  const zh = lang === Lang.Zh;
  if (mode === 'auto') return zh ? '[需要补充信息] 已选择开启自动执行,但固定跟单金额和/或每笔上限尚不完整。请直接补充缺失值(单位 USDT);也可以注明使用 USDC。若同一个数字同时作为两项,请明确说明。'
    : '[More information required] Auto-execution was selected, but the fixed per-signal amount and/or per-trade limit is missing. Provide only the missing values in USDT; optionally say use USDC. If one number is supplied for both fields, state that explicitly.';
  if (mode === 'manual') return zh ? '[需要补充信息] 已选择仅执行本次,但尚未提供本次交易金额。请直接提供金额(单位 USDT),也可以注明使用 USDC。'
    : '[More information required] One-time execution was selected, but this trade\'s amount is missing. Provide the amount in USDT; optionally say use USDC.';
  return zh ? '[需要补充信息] 跟单执行策略尚不完整。请明确更新执行策略后再处理后续交付物；本次交付物仍会保存，不会执行交易。'
    : '[More information required] The copy-trade execution policy is incomplete. Update the policy explicitly before processing future deliveries; this delivery remains saved and no trade will be executed.';
}
// upstream: card.rs::make_consent_input_required_decision
export const makeConsentInputRequiredDecision = (jobId, agentId, mode) =>
  makeDecision('consent_input_required', 'trade', jobId, agentId, CONFIG_REQUIRED_SOURCE_EVENT, consentInputRequiredContent(mode, resolveLang(jobId)));

// upstream: card.rs::make_consent_confirmation_decision
export function makeConsentConfirmationDecision(jobId, agentId, mode, tradeAmountU, capU, quote) {
  const q = asciiUpper(quote);
  const zh = resolveLang(jobId) === Lang.Zh;
  const a = tradeAmountU ?? '', c = capU ?? '';
  let content;
  if (mode === 'auto') content = zh ? `[请确认] 已识别为：开启自动执行；固定跟单金额 ${a} ${q}；每笔金额上限 ${c} ${q}。回复「确认」保存，或直接说明需要修改的值。`
    : `[Please confirm] I understood your setting as: enable auto-execution; fixed amount ${a} ${q}; per-trade limit ${c} ${q}. Reply "confirm" to save it, or state the value you want to change.`;
  else if (mode === 'manual') content = zh ? `[请确认] 已识别为：仅执行本次，金额 ${a} ${q}，后续信号继续手动确认。回复「确认」保存，或直接说明需要修改的值。`
    : `[Please confirm] I understood your setting as: execute this trade only for ${a} ${q} and keep future signals manual. Reply "confirm" to save it, or state the value you want to change.`;
  else content = zh ? '[请确认] 是否跳过本次自动执行？回复「确认」继续，或直接说明其他选择。'
    : '[Please confirm] Skip this automatic execution? Reply "confirm" to continue, or state a different choice.';
  return makeDecision('consent_confirmation', 'trade', jobId, agentId, CONFIG_REQUIRED_SOURCE_EVENT, content);
}

// upstream: card.rs::consent_over_cap_content / make_over_cap_decision
export function makeOverCapDecision(deliveryId, signalType, jobId, agentId, amountU, capU) {
  const q = asciiUpper(quoteToken(jobId));
  const content = resolveLang(jobId) === Lang.Zh
    ? `[Decision] 这个订阅的这笔自动跟单金额约 ${amountU} ${q},超过你设的每笔上限 ${capU} ${q}。请选择:\n  A. 仅执行本次,不修改每笔上限\n  B. 跳过本次(保持原上限不变)`
    : `[Decision] This subscription's auto copy-trade is about ${amountU} ${q}, above your per-trade limit of ${capU} ${q}. Please choose:\n  A. Execute this trade once without changing the limit\n  B. Skip this trade (keep the current limit)`;
  return makeDecision(deliveryId, signalType, jobId, agentId, OVER_CAP_SOURCE_EVENT, content);
}

// upstream: card.rs::plugin_install_content
function pluginInstallContent(plugin, canChangeTool, lang) {
  const zh = lang === Lang.Zh;
  const change = canChangeTool ? (zh ? '\n  C. 更换执行工具' : '\n  C. Choose another execution tool') : '';
  if (plugin === 'trade-kit') {
    return zh ? `[请确认] 自动执行本次跟单需要 OKX Trade Kit,但本地 CLI 尚未安装或配置。现在处理吗?\n  A. 安装或配置 Trade Kit 并执行本次交易\n  B. 跳过本次自动执行(交付物仍会保存,可稍后用任意工具手动处理)${change}`
      : `[Confirmation Needed] This copy-trade needs OKX Trade Kit, but its local CLI is missing or not configured. Install/configure it now?\n  A. Install or configure Trade Kit and execute this trade\n  B. Skip automatic execution (the deliverable stays saved for manual handling with any tool)${change}`;
  }
  return zh ? `[请确认] 自动执行本次跟单需要 ${plugin} 插件,当前尚未安装。现在安装吗?\n  A. 安装插件并执行本次交易(后续信号将自动执行)\n  B. 跳过本次自动执行(不安装;交付物仍会保存,可稍后用任意工具手动处理)${change}`
    : `[Confirmation Needed] Auto-executing this copy-trade needs the ${plugin} plugin, which isn't installed yet. Install it now?\n  A. Install the plugin and execute this trade (future signals then run automatically)\n  B. Skip automatic execution (don't install; the deliverable stays saved for manual handling with any tool)${change}`;
}
// upstream: card.rs::plugin_decision_command
const pluginDecisionCommand = (jobId, agentId, plugin) =>
  `onchainos agent pending-decisions-v2 request --job-id ${jobId} --role user --agent-id ${agentId} --source-event ${PLUGIN_INSTALL_SOURCE_EVENT} --list-label "${pluginListLabel(plugin)}" --user-content "<userContent verbatim — already in the user's language>"`;
function makePluginInstallDecisionInner(deliveryId, signalType, jobId, agentId, plugin, canChangeTool) {
  return {
    autoTrade: true, executed: false, decision: true, deliveryId, signalType, jobId, sourceEvent: PLUGIN_INSTALL_SOURCE_EVENT,
    userContent: pluginInstallContent(plugin, canChangeTool, resolveLang(jobId)), command: pluginDecisionCommand(jobId, agentId, plugin),
    guidance: DECISION_GUIDANCE, requiresPlugin: plugin,
  };
}
// upstream: card.rs::make_plugin_install_decision / make_plugin_install_decision_with_tool_change
export const makePluginInstallDecision = (deliveryId, signalType, jobId, agentId, plugin) => makePluginInstallDecisionInner(deliveryId, signalType, jobId, agentId, plugin, false);
export const makePluginInstallDecisionWithToolChange = (deliveryId, signalType, jobId, agentId, plugin) => makePluginInstallDecisionInner(deliveryId, signalType, jobId, agentId, plugin, true);
