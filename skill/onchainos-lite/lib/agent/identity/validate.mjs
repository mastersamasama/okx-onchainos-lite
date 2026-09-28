// Pure-local listing validator (hidden `agent validate-listing`) — upstream
// commands/agent_commerce/identity/validate.rs. No HTTP, no files. Output is NOT the envelope:
// `println!("{}", serde_json::to_string_pretty(&ValidationResult))` (struct order).
import { struct } from '../../core/json.mjs';
import { fromStr, SerdeError } from './_from-str.mjs';
import { trim, trimEnd, asciiLower, eqIgnoreAsciiCase, isNum, numText } from '../_rs.mjs';
import { asciiUpper } from '../../core/_rust-str.mjs';
import { AGENT_SERVICES_DE, ServiceOperation } from './models.mjs';
import { displayWidth, isPlainNumber, isPositiveInteger, isZeroValue, normalizeRole, SERVICE_GUIDE_MAX_DISPLAY_WIDTH } from './utils.mjs';

// upstream: validate.rs::validate_listing — args {role?, name?, description?, service?} → ValidationResult
export function validateListing(args) {
  let role = 'asp';
  if (args.role !== undefined && args.role !== null) { try { role = normalizeRole(args.role); } catch { role = 'asp'; } }
  return runValidation(role, args.name, args.description, args.service);
}

// upstream: validate.rs::fe (canonical fail messages)
export const fe = Object.freeze({
  FE03: 'The Agent name doesn\'t meet the naming rules: it may contain a test marker, an ordinal suffix, or special symbols, or its length or bilingual format is invalid. Use a clean brand name instead: 2–12 characters in Chinese or 3–25 in English, with no test markers, ordinals, or special symbols; for a bilingual name, use the "Chinese name · English name" format. Then resubmit.',
  FE05: 'The Agent description has an issue: it contains a URL or a test marker (e.g. "(test)", "-pre", or a trailing "beta"), exceeds 500 characters, or is empty. Remove any links and test markers, trim it to 500 characters or fewer, and make sure it\'s filled in. Then resubmit.',
  FE06: 'The service name doesn\'t meet the rules: its length is out of range, it duplicates the Agent name or another service name, or it contains pricing or a test marker. Keep every service name unique, 5–30 characters long, and different from the Agent name; move any pricing to the fee field, remove test markers, then resubmit.',
  FE10: 'The service type must be exactly A2A or A2MCP; the current value is invalid. Select A2A or A2MCP from the menu, then resubmit.',
  FE10_U5: 'The service name or description mentions a different service type than the one selected — an A2A service that says "A2MCP", or the reverse. Keep the service type you picked and delete that word from the name or description; only change the service type if you actually offer the other one. Then resubmit.',
  FE11: 'The endpoint configuration is invalid: A2MCP requires an endpoint while A2A must not have one, and it must be a publicly accessible HTTPS URL — not a private-network address or one starting with 0x. For A2MCP, enter a publicly accessible https URL; for A2A, remove the endpoint. Then resubmit.',
  FE12: 'The A2MCP fee must be a plain number (enter 0 for free), but the current value contains units, non-numeric text, or more than 6 decimal places. Enter the fee as a number only (e.g., 10; 0 for free) — it\'s denominated in USDT by default, with up to 6 decimal places and no symbols or extra text. Then resubmit.',
  FE12_A2A: 'The A2A pay-per-use fee must be a plain number, but the current value contains units, non-numeric text, or more than 2 decimal places. Enter the fee as a number only (e.g., 10 or 0.25) — it\'s denominated in USDT by default, with up to 2 decimal places and no symbols or extra text. Then resubmit.',
  FE13: 'The service data isn\'t a valid JSON array, or the create/update/delete operations don\'t match the id rules. Follow the sample format — omit the id when creating, and include the id when updating or deleting — then resubmit.',
  FE17: 'The subscription billing setup is invalid: A2MCP doesn\'t support subscriptions, and an A2A service must use exactly one of pay-per-use or monthly subscription — you can\'t leave both empty or fill in both. Pick one billing mode for your A2A service: set a pay-per-use fee, or set a monthly subscription (leave fee as an empty string "" when using subscription); for A2MCP, remove the subscription field. Then resubmit.',
  FE18: 'Subscriptions currently support monthly billing only, but a different interval was provided. Set the subscription tier\'s interval to "month" (weekly, yearly, and other intervals aren\'t supported yet), then resubmit.',
  FE19: 'The A2A subscription price must be a plain number, but the current value contains units, symbols, non-numeric text, or more than 2 decimal places. Enter each tier\'s price as a number only (e.g., 10 or 0.25) — denominated in USDT by default, up to 2 decimal places, no symbols or extra text. Then resubmit.',
  FE20: 'The free-trial setup is invalid: freeTrial can only be configured on monthly-subscription A2A services and must be a positive integer number of hours; A2MCP and pay-per-use services can\'t offer a trial. Guided writes use "72" (3 days); preserve another positive integer only when writing back a legacy service. Otherwise omit freeTrial entirely (don\'t set "" or "0"). Then resubmit.',
  FE21_D1: 'The service description is empty. Fill in what the service does, then resubmit.',
  FE21_D2: 'The service description is longer than the recommended 1000 CJK characters (2000 half-width). Trimming it is recommended — this is a suggestion, so you can submit it as is.',
  serviceGuideTooLong: (name) => `The service guide for [${name}] exceeds the length limit. Shorten it to no more than 5,000 full-width Chinese/Japanese characters or 10,000 Latin characters, then resubmit.`,
  fePriceEmpty: (name) => `The price for "${name}" cannot be empty. Please enter a price and try again.`,
  fePriceZero: (name) => `The subscription price for "${name}" must be greater than 0. Please update the price and try again.`,
  feEp01: (name, conflicting) => `The Endpoint for "${name}" is already used by "${conflicting}". Please use a different Endpoint and try again. If you have any questions, contact the OKX.AI team via customer support in the bottom-right corner of okx.ai.`,
  fe22(hasUrl, hasMarker) {
    const removals = [];
    if (hasUrl) removals.push('the link');
    if (hasMarker) removals.push('the test marker');
    if (!removals.length) return "The service description contains content that isn't allowed here.";
    let msg = `The service description needs a change: remove ${removals.join(' and ')}.`;
    if (hasUrl || hasMarker) msg += ' Then resubmit.';
    return msg;
  },
});

// upstream: validate.rs::Finding (struct order: field, code, severity, message)
const finding = (field, code, severity, message) => struct({ field, code, severity, message });
const block = (field, code, message) => finding(field, code, 'block', message);
const suggest = (field, code, message) => finding(field, code, 'suggest', message);

// upstream: validate.rs::parse_services_lenient → services | null (serde failure)
export function parseServicesLenient(raw) {
  let services;
  try { services = fromStr(raw, AGENT_SERVICES_DE); } catch (e) {
    if (e instanceof SerdeError) return null;
    throw e;
  }
  for (const s of services) {
    s.serviceName = trim(s.serviceName);
    s.serviceDescription = trim(s.serviceDescription);
    s.serviceGuide = trim(s.serviceGuide);
    s.fee = trim(s.fee);
    s.serviceType = trim(s.serviceType);
    s.endpoint = s.endpoint === null ? null : trim(s.endpoint);
    s.freeTrial = s.freeTrial === null ? null : trim(s.freeTrial);
  }
  return services;
}

// upstream: validate.rs::run_validation(role, name, description, service) → ValidationResult struct
export function runValidation(role, name, description, service) {
  const findings = [];
  const n = name === undefined || name === null ? '' : trim(name);
  const d = description === undefined || description === null ? '' : trim(description);
  checkName(n, findings);
  if (d !== '') {
    if (hasTestMarker(d)) findings.push(block('description', 'U1', fe.FE05));
    if (role === 'asp') {
      if (containsUrl(d)) findings.push(block('description', 'D6', fe.FE05));
      if ([...d].length > 500) findings.push(block('description', 'D8', fe.FE05));
    }
  }
  if (role === 'asp' && service !== undefined && service !== null) {
    const raw = trim(service);
    if (raw !== '') {
      const services = parseServicesLenient(raw);
      if (services) {
        services.forEach((svc, i) => checkService(i, svc, n, findings));
        checkDuplicateServiceNames(services, findings);
        checkDuplicateEndpoints(services, findings);
      } else findings.push(block('service', 'PARSE', fe.FE13));
    }
  }
  const pass = !findings.some((f) => f.severity === 'block');
  return struct({ pass, findings });
}

// upstream: validate.rs::check_name (private)
function checkName(name, findings) {
  if (name === '') return;
  if (hasTestMarker(name)) findings.push(block('name', 'U1', fe.FE03));
  const count = [...name].length;
  if (containsCjk(name) && !containsLatinLetter(name)) {
    if (count < 2 || count > 12) findings.push(block('name', 'N1', fe.FE03));
  } else if (count < 3 || count > 25) findings.push(block('name', 'N1', fe.FE03));
  if (hasEmbeddedAgentId(name)) findings.push(block('name', 'N2', fe.FE03));
  if (hasOrdinalSuffix(name)) findings.push(block('name', 'N3', fe.FE03));
  if (containsCjk(name) && containsLatinLetter(name) && !name.includes(' · ')) findings.push(block('name', 'N6', fe.FE03));
  if (hasDecorativeSymbols(name)) findings.push(block('name', 'N8', fe.FE03));
}

// upstream: validate.rs::check_service (private)
function checkService(index, svc, agentName, findings) {
  const f = (sub) => `service[${index}].${sub}`;
  const stype = asciiUpper(svc.serviceType);
  const isA2mcp = stype === 'A2MCP';
  const isA2a = stype === 'A2A';
  if (!isA2mcp && !isA2a) findings.push(block(f('servicetype'), 'T1', fe.FE10));
  const endpointEmpty = trim(svc.endpoint ?? '') === '';
  if (isA2mcp && endpointEmpty) findings.push(block(f('endpoint'), 'T2', fe.FE11));
  if (isA2a && !endpointEmpty) findings.push(block(f('endpoint'), 'T3', fe.FE11));
  if (isA2mcp && !endpointEmpty) {
    const ep = trim(svc.endpoint ?? '');
    if (!ep.startsWith('https://')) findings.push(block(f('endpoint'), 'T4', fe.FE11));
    else {
      const rest = ep.slice('https://'.length);
      const hostPort = rest.split('/')[0];
      const host = hostPort.split(':')[0].toLowerCase();
      let octet = false;
      if (host.startsWith('172.')) {
        const seg = host.slice(4).split('.')[0];
        if (/^\+?[0-9]+$/.test(seg) && BigInt(seg) <= 255n) { const v = Number(BigInt(seg)); octet = v >= 16 && v <= 31; }
      }
      const isPrivate = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.startsWith('10.') || host.startsWith('192.168.')
        || host.endsWith('.local') || host.endsWith('.internal') || octet;
      if (isPrivate) findings.push(block(f('endpoint'), 'T4', fe.FE11));
    }
  }
  if (stype !== '' && (isA2mcp || isA2a)) {
    for (const [sub, text] of [['name', svc.serviceName], ['servicedescription', svc.serviceDescription]]) {
      if (contradictingTypeToken(text, stype) !== undefined) findings.push(block(f(sub), 'U5', fe.FE10_U5));
    }
  }
  if (svc.serviceName !== '') {
    const c = [...svc.serviceName].length;
    if (c < 5 || c > 30) findings.push(block(f('name'), 'S1', fe.FE06));
    if (agentName !== '' && eqIgnoreAsciiCase(trim(svc.serviceName), trim(agentName))) findings.push(block(f('name'), 'S3', fe.FE06));
    if (containsPriceInfo(svc.serviceName)) findings.push(block(f('name'), 'S4', fe.FE06));
    if (hasTestMarker(svc.serviceName)) findings.push(block(f('name'), 'S6', fe.FE06));
  }
  checkPricing(index, svc, isA2mcp, isA2a, findings);
  if (svc.operation !== ServiceOperation.Delete && svc.serviceGuide !== '' && displayWidth(svc.serviceGuide) > SERVICE_GUIDE_MAX_DISPLAY_WIDTH) {
    findings.push(block(`service[${index}].serviceGuide`, 'G2', fe.serviceGuideTooLong(svc.serviceName)));
  }
  checkServiceDescription(index, svc.serviceDescription, isA2mcp, findings);
}

// upstream: validate.rs::check_duplicate_service_names (private)
function checkDuplicateServiceNames(services, findings) {
  const seen = [];
  services.forEach((s, index) => {
    if (s.serviceName === '') return;
    if (seen.some((n) => eqIgnoreAsciiCase(n, s.serviceName))) findings.push(block(`service[${index}].name`, 'S2', fe.FE06));
    else seen.push(s.serviceName);
  });
}

// upstream: validate.rs::check_duplicate_endpoints (private) — EP1
function checkDuplicateEndpoints(services, findings) {
  const seen = [];   // [endpoint, firstIndex, selfId | undefined]
  services.forEach((s, index) => {
    if (s.operation === ServiceOperation.Delete) return;
    const ep = s.endpoint === null ? '' : trim(s.endpoint);
    if (ep === '') return;
    let selfId;
    if (typeof s.id === 'string' && s.id !== '') selfId = s.id;
    else if (isNum(s.id)) selfId = numText(s.id);
    const conflict = seen.find(([e, , id]) => eqIgnoreAsciiCase(e, ep) && !(selfId !== undefined && id === selfId));
    if (conflict) findings.push(block(`service[${index}].endpoint`, 'EP1', fe.feEp01(s.serviceName, services[conflict[1]].serviceName)));
    else if (!seen.some(([e]) => eqIgnoreAsciiCase(e, ep))) seen.push([ep, index, selfId]);
  });
}

// upstream: validate.rs::check_pricing (private)
function checkPricing(index, svc, isA2mcp, isA2a, findings) {
  const feeField = `service[${index}].fee`, subField = `service[${index}].subscription`, trialField = `service[${index}].freeTrial`;
  const fee = trim(svc.fee);
  const feePresent = fee !== '';
  const hasSubscription = svc.subscription.length > 0;
  const trial = svc.freeTrial === null ? '' : trim(svc.freeTrial);
  if (isA2mcp) {
    if (hasSubscription) findings.push(block(subField, 'P3', fe.FE17));
    if (trial !== '') findings.push(block(trialField, 'P7', fe.FE20));
    if (!feePresent) { findings.push(block(feeField, 'U4', fe.FE12)); findings.push(block(feeField, 'P1', fe.FE12)); }
    else if (!isPlainNumber(fee, 6)) findings.push(block(feeField, 'P1', fe.FE12));
    return;
  }
  if (isA2a) {
    if (!feePresent && !hasSubscription) findings.push(block(feeField, 'P2', fe.FE17));
    if (feePresent && hasSubscription) findings.push(block(feeField, 'P6', fe.FE17));
    if (feePresent && !isPlainNumber(fee, 2)) findings.push(block(feeField, 'P1', fe.FE12_A2A));
    for (const tier of svc.subscription) {
      if (!eqIgnoreAsciiCase(trim(tier.interval), 'month')) findings.push(block(subField, 'P4', fe.FE18));
      const tfee = trim(tier.fee);
      if (tfee === '') findings.push(block(subField, 'PRICE_EMPTY', fe.fePriceEmpty(svc.serviceName)));
      else if (!isPlainNumber(tfee, 2)) findings.push(block(subField, 'P5', fe.FE19));
      else if (isZeroValue(tfee)) findings.push(block(subField, 'SUBSCRIPTION_PRICE_ZERO', fe.fePriceZero(svc.serviceName)));
    }
    if (trial !== '') {
      if (!hasSubscription) findings.push(block(trialField, 'P7', fe.FE20));
      if (!isPositiveInteger(trial)) findings.push(block(trialField, 'P8', fe.FE20));
    }
    return;
  }
  if (feePresent && !isPlainNumber(fee, 6)) findings.push(block(feeField, 'P1', fe.FE12));
}

// upstream: validate.rs::check_service_description (private)
function checkServiceDescription(index, desc, isA2mcp, findings) {
  const fd = `service[${index}].servicedescription`;
  const hasUrl = !isA2mcp && containsUrl(desc);
  const hasMarker = hasTestMarker(desc);
  if (hasUrl || hasMarker) {
    const msg = fe.fe22(hasUrl, hasMarker);
    if (hasUrl) findings.push(block(fd, 'D6', msg));
    if (hasMarker) findings.push(block(fd, 'U1', msg));
  }
  if (isA2mcp) return;
  if (trim(desc) === '') { findings.push(block(fd, 'D1', fe.FE21_D1)); return; }
  if (displayWidth(desc) > 2000) findings.push(suggest(fd, 'D2', fe.FE21_D2));
}

// ─── Pure predicates ────────────────────────────────────────────────────────

const isCjkChar = (cp) => (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x3000 && cp <= 0x303f);
// upstream: validate.rs::contains_cjk (private)
export const containsCjk = (s) => [...s].some((ch) => isCjkChar(ch.codePointAt(0)));
// upstream: validate.rs::contains_latin_letter (private)
export const containsLatinLetter = (s) => /[A-Za-z]/.test(s);
const isAsciiAlnum = (ch) => ch !== undefined && /^[0-9A-Za-z]$/.test(ch);

const BRACKETED = ['(pre)', '(test)', '(dev)', '(beta)', '(alpha)', '(staging)', '(uat)', '(sandbox)', '[pre]', '[test]', '[dev]', '[beta]', '{pre}', '{test}'];
const DELIM_MARKERS = [['-', 'pre'], ['-', 'test'], ['-', 'dev'], ['-', 'beta'], ['-', 'staging'], ['_', 'pre'], ['_', 'test'], ['_', 'dev'],
  ['_', 'beta'], ['_', 'staging'], ['.', 'pre'], ['.', 'test']];
const TRAILING = [' pre', ' test', ' dev', ' beta', ' staging'];

// upstream: validate.rs::has_test_marker (private)
export function hasTestMarker(s) {
  const lower = asciiLower(s);
  if (BRACKETED.some((m) => lower.includes(m))) return true;
  if (DELIM_MARKERS.some(([d, w]) => delimitedMarkerPresent(lower, d, w))) return true;
  return TRAILING.some((m) => lower.endsWith(m));
}

// upstream: validate.rs::delimited_marker_present (private)
function delimitedMarkerPresent(lower, delim, word) {
  const needle = delim + word;
  let from = 0;
  for (;;) {
    const start = lower.indexOf(needle, from);
    if (start < 0) return false;
    const after = lower.slice(start + needle.length);
    const next = after.length ? String.fromCodePoint(after.codePointAt(0)) : undefined;
    if (next === undefined || !isAsciiAlnum(next)) return true;
    from = start + 1;
  }
}

// upstream: validate.rs::has_embedded_agent_id (private)
export function hasEmbeddedAgentId(name) {
  if (markerDigitRun(name, '#') || markerDigitRun(name, '_')) return true;
  const idx = name.lastIndexOf(' ');
  if (idx >= 0) {
    const tail = name.slice(idx + 1);
    if (tail !== '' && /^[0-9]+$/.test(tail)) return true;
  }
  return false;
}

// upstream: validate.rs::marker_digit_run (private)
function markerDigitRun(name, marker) {
  const chars = [...name];
  for (let i = 0; i < chars.length; i++) if (chars[i] === marker && chars[i + 1] !== undefined && /^[0-9]$/.test(chars[i + 1])) return true;
  return false;
}

// upstream: validate.rs::has_ordinal_suffix (private)
export function hasOrdinalSuffix(name) {
  const lower = asciiLower(trimEnd(name));
  if (lower.endsWith(')')) {
    const open = lower.lastIndexOf('(');
    if (open >= 0) {
      const inner = lower.slice(open + 1, lower.length - 1);
      if (inner !== '' && /^[0-9]+$/.test(inner)) return true;
    }
  }
  const m = /[0-9]+$/.exec(lower);
  if (!m) return false;
  const prefix = lower.slice(0, lower.length - m[0].length);
  if (prefix.endsWith('#')) return true;
  if (prefix.endsWith('_v') || prefix.endsWith('_')) return true;
  if (prefix.endsWith('no.') || prefix.endsWith('no')) return true;
  return false;
}

// upstream: validate.rs::has_decorative_symbols (private)
export function hasDecorativeSymbols(name) {
  if (/[!?@#$%*~/\\|+=]/.test(name)) return true;
  if (name.includes('-')) {
    const t = trim(name);
    if (t.startsWith('-') || t.endsWith('-')) return true;
    if (name.includes(' - ')) return true;
  }
  return false;
}

// upstream: validate.rs::contains_url (private)
export function containsUrl(s) {
  const lower = asciiLower(s);
  return lower.includes('http://') || lower.includes('https://') || lower.includes('github.com');
}

// upstream: validate.rs::contains_price_info (private)
export function containsPriceInfo(s) {
  const lower = asciiLower(s);
  if (standaloneWord(lower, 'free') || s.includes('免费')) return true;
  for (const cur of ['usdt', 'usdg']) {
    let from = 0;
    for (;;) {
      const pos = lower.indexOf(cur, from);
      if (pos < 0) break;
      const before = trimEnd(lower.slice(0, pos));
      if (before.length && /[0-9]$/.test(before)) return true;
      from = pos + cur.length;
    }
  }
  return false;
}

// upstream: validate.rs::standalone_word (private)
export function standaloneWord(lower, word) {
  let from = 0;
  for (;;) {
    const start = lower.indexOf(word, from);
    if (start < 0) return false;
    const end = start + word.length;
    // the char before `start`: a surrogate half means a non-ASCII char (never alphanumeric)
    const leftOk = start === 0 || !isAsciiAlnum(lower[start - 1]);
    const after = lower.slice(end);
    const next = after.length ? String.fromCodePoint(after.codePointAt(0)) : undefined;
    const rightOk = next === undefined || !isAsciiAlnum(next);
    if (leftOk && rightOk) return true;
    from = start + 1;
  }
}

// upstream: validate.rs::contradicting_type_token (private) → 'A2MCP' | 'A2A' | undefined
export function contradictingTypeToken(text, stype) {
  const lower = asciiLower(text);
  const up = asciiUpper(stype);
  const candidates = up === 'A2A' ? ['a2mcp'] : up === 'A2MCP' ? ['a2a'] : undefined;
  if (!candidates) return undefined;
  for (const tok of candidates) if (standaloneWord(lower, tok)) return asciiUpper(tok);
  return undefined;
}
