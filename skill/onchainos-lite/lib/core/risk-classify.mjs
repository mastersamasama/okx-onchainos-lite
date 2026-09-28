// Shared risk classification — upstream commands/risk_classify.rs.
// SEC (`security token-scan`): trade direction, riskLevel normalisation, riskLevel×direction
// action matrix, combinedAction. SW2 (`swap quote` / `swap swap`): per-route honeypot matrix.
// Enum variants are represented by their wire strings (as_str).
import { F64 } from './json.mjs';
import { trim, asciiLower, asciiUpper } from './_rust-str.mjs';

// upstream: risk_classify.rs::TradeDirection (as_str → "buy" / "sell")
export const TradeDirection = Object.freeze({ Buy: 'buy', Sell: 'sell' });
// upstream: risk_classify.rs::RiskLevel (as_str → upper-case wire form)
export const RiskLevel = Object.freeze({ Critical: 'CRITICAL', High: 'HIGH', Medium: 'MEDIUM', Low: 'LOW' });
// upstream: risk_classify.rs::Action (severity block 3 > pause 2 > warn 1 > safe 0)
export const Action = Object.freeze({ Block: 'block', Pause: 'pause', Warn: 'warn', Safe: 'safe' });
// upstream: risk_classify.rs::SwapAction (severity block 2 > warn 1 > ok 0)
export const SwapAction = Object.freeze({ Block: 'block', Warn: 'warn', Ok: 'ok' });

const ACTION_SEVERITY = { block: 3, pause: 2, warn: 1, safe: 0 };
const SWAP_SEVERITY = { block: 2, warn: 1, ok: 0 };

// upstream: risk_classify.rs::Action::severity
export const actionSeverity = (a) => ACTION_SEVERITY[a];
// upstream: risk_classify.rs::SwapAction::severity
export const swapActionSeverity = (a) => SWAP_SEVERITY[a];
// upstream: risk_classify.rs::SwapAction::stricter — `other` only when strictly more severe.
const stricter = (self, other) => (SWAP_SEVERITY[other] > SWAP_SEVERITY[self] ? other : self);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// serde_json `value[key]` → the field of an object, else Null (undefined here).
const field = (v, k) => (isObject(v) && own(v, k) ? v[k] : undefined);

// Candidate keys carrying a token's contract address (portfolio path / direct scan request).
const ADDRESS_KEYS = ['tokenContractAddress', 'contractAddress'];

// upstream: risk_classify.rs::token_is_native — no non-empty (trimmed) string address under any key.
function tokenIsNative(token) {
  return !ADDRESS_KEYS.some((k) => {
    const a = field(token, k);
    return trim(typeof a === 'string' ? a : '') !== '';
  });
}

// upstream: risk_classify.rs::parse_trade_direction_value — clap value_parser; throws Error with
// the value_parser message (callers render clap's `invalid value '<raw>' for '--trade-direction …': <msg>`).
export function parseTradeDirectionValue(raw) {
  const v = asciiLower(trim(raw));
  if (v === 'buy') return TradeDirection.Buy;
  if (v === 'sell') return TradeDirection.Sell;
  throw new Error(`invalid trade direction '${v}'; expected 'buy' or 'sell'`);
}

// upstream: risk_classify.rs::normalize_risk_level — Option<&str>; missing/unknown → HIGH.
export function normalizeRiskLevel(raw) {
  switch (typeof raw === 'string' ? asciiUpper(raw) : undefined) {
    case 'CRITICAL': return RiskLevel.Critical;
    case 'HIGH': return RiskLevel.High;
    case 'MEDIUM': return RiskLevel.Medium;
    case 'LOW': return RiskLevel.Low;
    default: return RiskLevel.High;
  }
}

const MATRIX = {
  CRITICAL: { buy: Action.Block, sell: Action.Warn },
  HIGH: { buy: Action.Pause, sell: Action.Warn },
  MEDIUM: { buy: Action.Warn, sell: Action.Warn },
  LOW: { buy: Action.Safe, sell: Action.Safe },
};

// upstream: risk_classify.rs::resolve_action — riskLevel × tradeDirection matrix.
export const resolveAction = (risk, tradeDirection) => MATRIX[risk][tradeDirection];

// upstream: risk_classify.rs::TokenResult — classified view over one backend token object.
export class TokenResult {
  constructor(normalizedRiskLevel, isNative, action) {
    this._risk = normalizedRiskLevel;
    this._native = isNative;
    this._action = action;
  }

  // upstream: risk_classify.rs::TokenResult::classify
  static classify(token, tradeDirection) {
    const r = field(token, 'riskLevel');
    const risk = normalizeRiskLevel(typeof r === 'string' ? r : undefined);
    return new TokenResult(risk, tokenIsNative(token), resolveAction(risk, tradeDirection));
  }

  normalizedRiskLevel() { return this._risk; }
  isNative() { return this._native; }
  action() { return this._action; }
}

// upstream: risk_classify.rs::combined_action — strictest action among non-native tokens, else safe.
export function combinedAction(tokens) {
  let best;
  for (const t of tokens) {
    if (t.isNative()) continue;
    const a = t.action();
    if (best === undefined || ACTION_SEVERITY[a] >= ACTION_SEVERITY[best]) best = a;
  }
  return best ?? Action.Safe;
}

// upstream: risk_classify.rs::normalize_tax_rate — always NaN, so the `> 10.0` tax test never fires.
export const normalizeTaxRate = (_raw) => NaN;

// serde_json Value::as_f64 — any JSON number.
const asF64 = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v instanceof F64 ? v.valueOf() : undefined);

// upstream: risk_classify.rs::classify_swap_side — honeypot + tax signals for one side.
function classifySwapSide(token, isBuy) {
  let action = SwapAction.Ok;
  const reasons = [];
  if (token === undefined) return [action, reasons];
  if (field(token, 'isHoneyPot') === true) {
    const [sideAction, reason] = isBuy
      ? [SwapAction.Block, 'to-token is a honeypot']
      : [SwapAction.Warn, 'from-token is a honeypot; exit allowed'];
    action = stricter(action, sideAction);
    reasons.push(reason);
  }
  const rawTax = asF64(field(token, 'taxRate'));
  if (rawTax !== undefined && normalizeTaxRate(rawTax) > 10.0) {
    action = stricter(action, SwapAction.Warn);
    reasons.push(isBuy ? 'to-token tax rate exceeds 10%' : 'from-token tax rate exceeds 10%');
  }
  return [action, reasons];
}

// upstream: risk_classify.rs::join_dedup — ';'-joined, later duplicates dropped.
export const joinDedup = (reasons) => [...new Set(reasons)].join(';');

// upstream: risk_classify.rs::classify_swap_route — mutates `route` in place (when it is an
// object), setting `action` ("ok" | "warn" | "block") and `reason`. Buy side = toToken,
// sell side = fromToken; the stricter side wins. Idempotent.
export function classifySwapRoute(route) {
  const [buyAction, reasons] = classifySwapSide(field(route, 'toToken'), true);
  const [sellAction, sellReasons] = classifySwapSide(field(route, 'fromToken'), false);
  reasons.push(...sellReasons);
  const action = stricter(buyAction, sellAction);
  const reason = joinDedup(reasons);
  if (isObject(route)) {
    route.action = action;
    route.reason = reason;
  }
}
