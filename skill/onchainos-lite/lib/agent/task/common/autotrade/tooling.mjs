// Subscription-time execution-tool preflight (`autoTradePreflight`) — upstream autotrade/tooling.rs.
// Deterministic, local, non-networked classification of a Service Guide / description into a
// bounded AssetClass set plus a local inventory of candidate tools.
import { homedir } from 'node:os';
import { struct } from '../../../../core/json.mjs';
import { AssetClass, ASSET_CLASS_ORDER } from '../../../../core/asset-class.mjs';
import { isSkillInstalledIn } from '../../../../commands/upgrade/upgrade.mjs';
import { probeLocalWith, localReadiness, LocalReadiness } from './trade-kit.mjs';
import { trim } from '../../../_rs.mjs';

const CN_HDR_SPOT = '【现货信号】';
const CN_HDR_PERP = '【合约信号】';
const CN_HDR_PREDICTION = '【预测市场信号】';
const CN_HDR_OPTION = '【期权信号】';
const CN_HDR_DEFI = '【defi 信号】';
const CN_SPOT = '现货';
const CN_PERP = '合约';
const CN_PERPETUAL = '永续';
const CN_FUTURES = '期货';
const CN_LEVERAGE = '杠杆';
const CN_TRADING_PAIR = '交易对';
const CN_PREDICTION = '预测';
const CN_OPTION = '期权';
const CN_STAKE = '质押';
const CN_LIQUIDITY = '流动性';
const CN_SIGNAL = '信号';
const CN_ENTRY = '入场';
const CN_STOP_LOSS = '止损';
const CN_TAKE_PROFIT = '止盈';
const CN_POSITION = '仓位';
const CN_LONG = '做多';
const CN_SHORT = '做空';
const CN_BUY = '买入';
const CN_SELL = '卖出';
const CN_PUSH = '推送';
const CN_COPY = '跟单';
const CN_NEG_NO_TRADE_SIGNAL = '不提供交易信号';
const CN_NEG_NO_SIGNAL = '不提供信号';
const CN_NEG_ONLY_QUOTE = '仅提供行情';

// upstream: tooling.rs::ExecutionTool (wire tokens) + token / display_name / plugin_id
export const ExecutionTool = Object.freeze({
  Onchainos: 'onchainos', TradeKit: 'trade_kit', PolymarketPlugin: 'polymarket_plugin', HyperliquidPlugin: 'hyperliquid_plugin',
  ALL: Object.freeze(['onchainos', 'trade_kit', 'polymarket_plugin', 'hyperliquid_plugin']),
  token: (t) => t,
  displayName: (t) => ({ onchainos: 'OnchainOS', trade_kit: 'Trade Kit', polymarket_plugin: 'Polymarket', hyperliquid_plugin: 'Hyperliquid' })[t],
  pluginId: (t) => ({ polymarket_plugin: 'polymarket-plugin', hyperliquid_plugin: 'hyperliquid-plugin' })[t] ?? null,
});
// upstream: tooling.rs::Readiness / ToolReadinessReason / ReminderKind / TradeKitProbeMode (wire strings)
export const Readiness = Object.freeze({ Ready: 'ready', Missing: 'missing', VerificationUnknown: 'verification_unknown', Incompatible: 'incompatible' });
export const ToolReadinessReason = Object.freeze({ Ready: 'ready', CliMissing: 'cli_missing', PluginMissing: 'plugin_missing', LocalCompatibilityNotChecked: 'local_compatibility_not_checked', Incompatible: 'incompatible' });
export const ReminderKind = Object.freeze({ InstallPlugin: 'install_plugin', ChooseAtFirstSignal: 'choose_at_first_signal', ReadinessAdvisory: 'readiness_advisory' });
export const TradeKitProbeMode = Object.freeze({ ProbeBeforeConfirmation: 'probe_before_confirmation', DeferredUntilVenueSelection: 'deferred_until_venue_selection', NotApplicable: 'not_applicable' });

// upstream: tooling.rs::candidate_tools
export function candidateTools(cls) {
  switch (cls) {
    case AssetClass.Spot: return [ExecutionTool.Onchainos, ExecutionTool.TradeKit];
    case AssetClass.Perp: return [ExecutionTool.HyperliquidPlugin, ExecutionTool.TradeKit];
    case AssetClass.Prediction: return [ExecutionTool.PolymarketPlugin, ExecutionTool.TradeKit];
    case AssetClass.Option: return [ExecutionTool.TradeKit];
    default: return [ExecutionTool.Onchainos];
  }
}

// str::to_lowercase (full Unicode lowercase; JS toLowerCase matches for these inputs)
const lowerOf = (s) => String(s).toLowerCase();
// split(|c| !c.is_ascii_alphanumeric()), non-empty
const tokensOf = (lower) => new Set(lower.split(/[^0-9A-Za-z]/).filter((s) => s !== ''));

// upstream: tooling.rs::classify_description → { classes, explicit, evidence }
export function classifyDescription(desc) {
  const empty = { classes: [], explicit: [], evidence: [] };
  if (trim(desc) === '') return empty;
  const lower = lowerOf(desc);
  if (hasHardNegation(lower)) return empty;
  const headerAny = ASSET_CLASS_ORDER.some((c) => headerPresent(c, lower));
  const declaresSignal = lower.includes('signal') || lower.includes(CN_SIGNAL);
  if (!headerAny && !declaresSignal && hasSoftReadonly(lower)) return empty;
  const tokens = tokensOf(lower);
  const namesPolymarket = lower.includes('polymarket');
  const namesHyperliquid = lower.includes('hyperliquid');
  const namesTradeKit = ['trade kit', 'trade-kit', 'okx-trade', 'okx trade', 'okx cex', 'okx event'].some((p) => lower.includes(p));
  const namesOnchainos = lower.includes('onchainos') || lower.includes('onchain os');
  const namesDex = tokens.has('dex');
  const actionable = hasActionable(lower, tokens);
  const classes = [], evidence = [];
  for (const c of ASSET_CLASS_ORDER) {
    if (headerPresent(c, lower)) { classes.push(c); evidence.push(`${c}:header`); }
    else if (actionable && classSemanticPresent(c, lower, tokens, namesPolymarket, namesHyperliquid, namesDex)) { classes.push(c); evidence.push(`${c}:description`); }
  }
  const recognized = new Set(classes.flatMap((c) => candidateTools(c)));
  const named = [[ExecutionTool.Onchainos, namesOnchainos || namesDex], [ExecutionTool.TradeKit, namesTradeKit],
    [ExecutionTool.PolymarketPlugin, namesPolymarket], [ExecutionTool.HyperliquidPlugin, namesHyperliquid]];
  const explicit = [];
  for (const [tool, isNamed] of named) if (isNamed && recognized.has(tool)) { explicit.push(tool); evidence.push(`tool:${tool}`); }
  return { classes, explicit, evidence };
}

// upstream: tooling.rs::header_present
function headerPresent(cls, lower) {
  const [cn, en] = {
    spot: [CN_HDR_SPOT, '【spot signal】'], perp: [CN_HDR_PERP, '【futures signal】'], prediction: [CN_HDR_PREDICTION, '【prediction signal】'],
    option: [CN_HDR_OPTION, '【options signal】'], defi: [CN_HDR_DEFI, '【defi signal】'],
  }[cls];
  return lower.includes(cn) || lower.includes(en);
}
// upstream: tooling.rs::class_semantic_present
function classSemanticPresent(cls, lower, tokens, namesPolymarket, namesHyperliquid, namesDex) {
  const t = (...xs) => xs.some((x) => tokens.has(x));
  switch (cls) {
    case AssetClass.Spot: return tokens.has('spot') || lower.includes(CN_SPOT) || namesDex;
    case AssetClass.Perp: return t('perp', 'perps', 'perpetual', 'futures', 'future') || hasPerpSwapInstrument(lower) || cnContractIsPerp(lower) || lower.includes(CN_PERPETUAL) || namesHyperliquid;
    case AssetClass.Prediction: return t('prediction', 'predictions') || lower.includes(CN_PREDICTION) || namesPolymarket || predictionComboPresent(tokens);
    case AssetClass.Option: return t('option', 'options') || lower.includes(CN_OPTION) || optionComboPresent(tokens);
    default: return t('defi', 'yield', 'staking', 'stake', 'farming', 'lp') || lower.includes(CN_STAKE) || lower.includes(CN_LIQUIDITY) || defiComboPresent(lower, tokens);
  }
}
// upstream: tooling.rs::has_perp_swap_instrument
function hasPerpSwapInstrument(lower) {
  return lower.split(/[^0-9A-Za-z-]/).some((chunk) => { const seg = chunk.split('-').filter((s) => s !== ''); return seg.length >= 3 && seg[seg.length - 1] === 'swap'; });
}
// upstream: tooling.rs::cn_contract_is_perp
function cnContractIsPerp(lower) {
  if (!lower.includes(CN_PERP)) return false;
  if (lower.includes(CN_HDR_PERP)) return true;
  return [CN_LONG, CN_SHORT, CN_LEVERAGE, CN_ENTRY, CN_STOP_LOSS, CN_TAKE_PROFIT, CN_PERPETUAL, CN_FUTURES, CN_TRADING_PAIR].some((k) => lower.includes(k));
}
// upstream: tooling.rs::prediction_combo_present
function predictionComboPresent(tokens) {
  const has = (...xs) => xs.some((x) => tokens.has(x));
  if (has('event', 'events') && has('contract', 'contracts', 'market', 'markets')) return true;
  return has('buy', 'sell') && has('yes', 'no') && has('outcome', 'outcomes', 'market', 'markets');
}
// upstream: tooling.rs::option_combo_present
function optionComboPresent(tokens) {
  const has = (...xs) => xs.some((x) => tokens.has(x));
  const callPut = has('call', 'calls', 'put', 'puts'), strike = has('strike', 'strikes'), expiry = has('expiry', 'expiries', 'expiration');
  return (callPut && (strike || expiry)) || (strike && expiry);
}
// upstream: tooling.rs::defi_combo_present
function defiComboPresent(lower, tokens) {
  const has = (...xs) => xs.some((x) => tokens.has(x));
  if (has('apy', 'apr', 'tvl', 'lending', 'lend', 'borrow', 'borrowing')) return true;
  if (lower.includes('liquidity pool')) return true;
  return has('pool', 'pools') && has('yield', 'liquidity', 'onchain', 'rewards', 'reward');
}
// upstream: tooling.rs::has_actionable
function hasActionable(lower, tokens) {
  if (['signal', 'signals', 'entry', 'buy', 'sell', 'long', 'short', 'position', 'positions', 'tp', 'sl', 'enter', 'exit'].some((x) => tokens.has(x))) return true;
  if (['stop loss', 'take profit', 'scheduled push', 'copy trade', 'copy-trade'].some((p) => lower.includes(p))) return true;
  return [CN_SIGNAL, CN_ENTRY, CN_STOP_LOSS, CN_TAKE_PROFIT, CN_POSITION, CN_LONG, CN_SHORT, CN_BUY, CN_SELL, CN_PUSH, CN_COPY].some((p) => lower.includes(p));
}
// upstream: tooling.rs::has_hard_negation
function hasHardNegation(lower) {
  if (['no trading signal', 'no signals are provided', 'no signal is provided', 'no signals provided', 'no signal provided', 'provides no signal',
    'provide no signal', 'does not provide signal', 'do not provide signal', 'not a signal service', 'not a trading signal service'].some((p) => lower.includes(p))) return true;
  return [CN_NEG_NO_TRADE_SIGNAL, CN_NEG_NO_SIGNAL].some((p) => lower.includes(p));
}
// upstream: tooling.rs::has_soft_readonly
function hasSoftReadonly(lower) {
  if (['analytics only', 'market data only', 'data feed only', 'read-only', 'read only', 'informational only', 'for reference only', 'reference only',
    'security alert', 'risk report'].some((p) => lower.includes(p))) return true;
  return lower.includes(CN_NEG_ONLY_QUOTE);
}

// upstream: tooling.rs::ToolInventory
export class ToolInventory {
  constructor(r) { Object.assign(this, r); }
  // upstream: ToolInventory::detect
  static detect() { return ToolInventory.detectWith(homedir(), process.env.PATH ?? ''); }
  // upstream: ToolInventory::detect_with
  static detectWith(home, pathVar) {
    const plugin = (id) => { try { return isSkillInstalledIn(home, id) ? Readiness.Ready : Readiness.Missing; } catch { return Readiness.Missing; } };
    const tk = localReadiness(probeLocalWith(home, pathVar)) === LocalReadiness.Missing ? Readiness.Missing : Readiness.VerificationUnknown;
    return new ToolInventory({ onchainos: Readiness.Ready, trade_kit: tk, polymarket_plugin: plugin('polymarket-plugin'), hyperliquid_plugin: plugin('hyperliquid-plugin') });
  }
  // upstream: ToolInventory::readiness_of
  readinessOf(tool) { return this[tool]; }
  // upstream: ToolInventory::reason_of
  reasonOf(tool) {
    const r = this.readinessOf(tool);
    if (r === Readiness.Ready) return ToolReadinessReason.Ready;
    if (r === Readiness.Missing) return tool === ExecutionTool.TradeKit ? ToolReadinessReason.CliMissing : ToolReadinessReason.PluginMissing;
    if (r === Readiness.VerificationUnknown) return ToolReadinessReason.LocalCompatibilityNotChecked;
    return ToolReadinessReason.Incompatible;
  }
}

// upstream: tooling.rs::build_preflight → AutoTradePreflight (struct order)
export function buildPreflight(desc, inv) {
  const o = classifyDescription(desc);
  return assemble(o.classes, o.explicit, o.evidence, inv);
}
// upstream: tooling.rs::build_service_preflight
export function buildServicePreflight(serviceGuide, serviceDescription, inv) {
  const g = serviceGuide === null || serviceGuide === undefined ? undefined : trim(serviceGuide);
  return buildPreflight(g !== undefined && g !== '' ? g : serviceDescription, inv);
}
// upstream: tooling.rs::build_preflight_from_classes
export function buildPreflightFromClasses(classes, explicit, inv) {
  const ordered = ASSET_CLASS_ORDER.filter((c) => classes.includes(c));
  const evidence = ordered.map((c) => `${c}:description`);
  for (const tool of ExecutionTool.ALL) if (explicit.includes(tool)) evidence.push(`tool:${tool}`);
  return assemble(ordered, explicit, evidence, inv);
}
// upstream: tooling.rs::degraded_preflight
export function degradedPreflight() {
  return preflightJson({ schemaVersion: 3, isTradingSignal: false, assetClasses: [], explicitTools: [], selectionRequired: false, advisoryOnly: true,
    tools: [], reminders: [], tradeKitProbe: { mode: TradeKitProbeMode.NotApplicable, assetClasses: [] }, evidence: ['preflight:unavailable'] });
}

const toolStatusJson = (t) => struct({ tool: t.tool, displayName: t.displayName, pluginId: t.pluginId ?? undefined, readiness: t.readiness, reason: t.reason, checkedAt: t.checkedAt ?? null });
const reminderJson = (r) => struct({ kind: r.kind, tool: r.tool ?? undefined, pluginId: r.pluginId ?? undefined, assetClasses: r.assetClasses, blocking: r.blocking, messageEn: r.messageEn, messageZh: r.messageZh });
const preflightJson = (p) => struct({
  schemaVersion: p.schemaVersion, isTradingSignal: p.isTradingSignal, assetClasses: p.assetClasses, explicitTools: p.explicitTools,
  selectionRequired: p.selectionRequired, advisoryOnly: p.advisoryOnly, tools: p.tools.map(toolStatusJson), reminders: p.reminders.map(reminderJson),
  tradeKitProbe: struct({ mode: p.tradeKitProbe.mode, assetClasses: p.tradeKitProbe.assetClasses }), evidence: p.evidence,
});

// upstream: tooling.rs::assemble
function assemble(classes, explicit, evidence, inv) {
  const toolList = [];
  for (const c of ASSET_CLASS_ORDER) if (classes.includes(c)) for (const t of candidateTools(c)) if (!toolList.includes(t)) toolList.push(t);
  const tools = toolList.map((tool) => ({ tool, displayName: ExecutionTool.displayName(tool), pluginId: ExecutionTool.pluginId(tool), readiness: inv.readinessOf(tool), reason: inv.reasonOf(tool), checkedAt: null }));
  const tradeKitProbe = tradeKitProbeDirective(classes, explicit);
  const reminders = [];
  let selectionRequired = false;
  for (const c of ASSET_CLASS_ORDER) {
    if (!classes.includes(c)) continue;
    const cands = candidateTools(c);
    const named = cands.filter((t) => explicit.includes(t));
    const effective = named.length ? named : [...cands];
    if (effective.length === 1) {
      const tool = effective[0];
      if (inv.readinessOf(tool) === Readiness.Missing && tool !== ExecutionTool.Onchainos) mergeReminder(reminders, ReminderKind.InstallPlugin, tool, c);
    } else {
      selectionRequired = true;
      mergeReminder(reminders, ReminderKind.ChooseAtFirstSignal, null, c);
      if (effective.every((t) => inv.readinessOf(t) !== Readiness.Ready)) {
        mergeReminder(reminders, ReminderKind.ReadinessAdvisory, null, c);
        for (const t of effective) if (inv.readinessOf(t) === Readiness.Missing && t !== ExecutionTool.Onchainos) mergeReminder(reminders, ReminderKind.InstallPlugin, t, c);
      }
    }
  }
  for (const r of reminders) { const [en, zh] = renderMessages(r.kind, r.tool, r.assetClasses.join('/')); r.messageEn = en; r.messageZh = zh; }
  return preflightJson({ schemaVersion: 3, isTradingSignal: classes.length > 0, assetClasses: [...classes], explicitTools: [...explicit], selectionRequired, advisoryOnly: true, tools, reminders, tradeKitProbe, evidence });
}

// upstream: tooling.rs::trade_kit_probe_directive
function tradeKitProbeDirective(classes, explicit) {
  const relevant = ASSET_CLASS_ORDER.filter((c) => classes.includes(c) && candidateTools(c).includes(ExecutionTool.TradeKit));
  if (!relevant.length) return { mode: TradeKitProbeMode.NotApplicable, assetClasses: [] };
  if (explicit.length === 1 && explicit[0] === ExecutionTool.TradeKit) return { mode: TradeKitProbeMode.ProbeBeforeConfirmation, assetClasses: relevant };
  const sole = relevant.filter((c) => { const t = candidateTools(c); return t.length === 1 && t[0] === ExecutionTool.TradeKit; });
  if (sole.length) return { mode: TradeKitProbeMode.ProbeBeforeConfirmation, assetClasses: sole };
  const everyAlt = !explicit.includes(ExecutionTool.TradeKit) && relevant.every((c) => candidateTools(c).some((t) => t !== ExecutionTool.TradeKit && explicit.includes(t)));
  return everyAlt ? { mode: TradeKitProbeMode.NotApplicable, assetClasses: [] } : { mode: TradeKitProbeMode.DeferredUntilVenueSelection, assetClasses: relevant };
}
// upstream: tooling.rs::merge_reminder
function mergeReminder(reminders, kind, tool, cls) {
  const ex = reminders.find((r) => r.kind === kind && r.tool === tool);
  if (ex) { if (!ex.assetClasses.includes(cls)) ex.assetClasses.push(cls); return; }
  reminders.push({ kind, tool, pluginId: tool ? ExecutionTool.pluginId(tool) : null, assetClasses: [cls], blocking: false, messageEn: '', messageZh: '' });
}
// upstream: tooling.rs::render_messages
function renderMessages(kind, tool, label) {
  if (kind === ReminderKind.InstallPlugin) {
    const name = tool ? ExecutionTool.displayName(tool) : 'the';
    if (tool === ExecutionTool.TradeKit) {
      return [`Install OKX Agent Skills (\`npx skills add okx/agent-skills\`) and the Trade Kit CLI (\`npm install -g @okx_ai/okx-trade-cli\`) to execute ${label} signals.`,
        `运行 npx skills add okx/agent-skills 安装 OKX Agent Skills，并运行 npm install -g @okx_ai/okx-trade-cli 安装 Trade Kit CLI，以执行 ${label} 信号。`];
    }
    return [`Install the ${name} plugin to execute ${label} signals.`, `安装 ${name} 插件以执行 ${label} 信号。`];
  }
  if (kind === ReminderKind.ChooseAtFirstSignal) {
    return [`Multiple execution venues are available for ${label}; choose one when the first real signal arrives.`, `${label} 有多个可选执行渠道；请在第一条真实信号到达时选择。`];
  }
  return [`None of the ${label} execution venues are ready yet; install or configure any one of them now, or wait for the first real signal to choose. Nothing is installed or selected for you.`,
    `${label} 的候选执行工具均未就绪；可安装或配置其中任一，或等待首个真实信号到达时再选择。`];
}
