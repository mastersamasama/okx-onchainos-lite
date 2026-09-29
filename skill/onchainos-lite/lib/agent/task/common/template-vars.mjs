// Template-variable decode / validate / render — upstream task/common/template_vars.rs.
import { B64 } from '../../../core/rs/codec.mjs';
import { byteLen, trim } from '../../../core/rs/str.mjs';
import { decodeUtf8 } from '../../../core/rs/fs.mjs';

// upstream: template_vars.rs::TEMPLATE_VAR_WHITELIST
export const TEMPLATE_VAR_WHITELIST = Object.freeze(['__OKX_TASK_TITLE__', '__OKX_TASK_LABEL_TITLE__', '__OKX_REFUND_SERVICE_NAME__',
  '__OKX_REFUND_JOB_ID__', '__OKX_REFUND_TASK_TYPE__', '__OKX_REFUND_CURRENT_PERIOD__', '__OKX_REFUND_AMOUNT__',
  '__OKX_REFUND_BUYER_REASON__', '__OKX_REFUND_RESPONSE_DEADLINE__']);
export const PLACEHOLDER_OPEN = '{{';
export const PLACEHOLDER_CLOSE = '}}';
export const TITLE_PLACEHOLDER = '{{__OKX_TASK_TITLE__}}';
export const LABEL_TITLE_PLACEHOLDER = '{{__OKX_TASK_LABEL_TITLE__}}';
export const REFUND_SERVICE_NAME_PLACEHOLDER = '{{__OKX_REFUND_SERVICE_NAME__}}';
export const REFUND_JOB_ID_PLACEHOLDER = '{{__OKX_REFUND_JOB_ID__}}';
export const REFUND_TASK_TYPE_PLACEHOLDER = '{{__OKX_REFUND_TASK_TYPE__}}';
export const REFUND_CURRENT_PERIOD_PLACEHOLDER = '{{__OKX_REFUND_CURRENT_PERIOD__}}';
export const REFUND_AMOUNT_PLACEHOLDER = '{{__OKX_REFUND_AMOUNT__}}';
export const REFUND_BUYER_REASON_PLACEHOLDER = '{{__OKX_REFUND_BUYER_REASON__}}';
export const REFUND_RESPONSE_DEADLINE_PLACEHOLDER = '{{__OKX_REFUND_RESPONSE_DEADLINE__}}';
export const MAX_TEMPLATE_VALUE_LEN = 4 * 1024;
export const MAX_TEMPLATE_PAYLOAD_BYTES = 16 * 1024;
export const CODE_VARS_INVALID = 'TEMPLATE_VARS_INVALID';
export const CODE_VALUE_MISSING = 'TEMPLATE_VALUE_MISSING';
export const CODE_PLACEHOLDER_MISSING = 'TEMPLATE_PLACEHOLDER_MISSING';

// upstream: template_vars.rs::TemplateVarError — `.code` + value-free Display.
export class TemplateVarError extends Error {
  constructor(kind) {
    const [code, msg] = {
      Invalid: [CODE_VARS_INVALID, 'template variables payload is invalid'],
      ValueMissing: [CODE_VALUE_MISSING, 'a declared placeholder has no matching template variable'],
      PlaceholderMissing: [CODE_PLACEHOLDER_MISSING, 'a supplied template variable has no matching placeholder'],
    }[kind];
    super(msg);
    this.kind = kind;
    this.code = code;
  }
}

const placeholderFor = (key) => `${PLACEHOLDER_OPEN}${key}${PLACEHOLDER_CLOSE}`;

// Strict JSON object parse with duplicate-key rejection (serde MapAccess visitor); throws on any error.
function parseObjectNoDup(text) {
  let i = 0;
  const s = text;
  const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
  const fail = () => { throw new TemplateVarError('Invalid'); };
  const str = () => {
    if (s[i] !== '"') fail();
    i++;
    let out = '';
    for (;;) {
      if (i >= s.length) fail();
      const c = s.charCodeAt(i);
      if (c === 0x22) { i++; return out; }
      if (c < 0x20) fail();
      if (c !== 0x5c) { out += s[i++]; continue; }
      const e = s[i + 1]; i += 2;
      if (e === 'u') {
        const h = s.slice(i, i + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail(); i += 4;
        let u = parseInt(h, 16);
        if (u >= 0xdc00 && u <= 0xdfff) fail();
        if (u >= 0xd800 && u <= 0xdbff) {
          if (s[i] !== '\\' || s[i + 1] !== 'u') fail();
          const h2 = s.slice(i + 2, i + 6); if (!/^[0-9a-fA-F]{4}$/.test(h2)) fail(); i += 6;
          const lo = parseInt(h2, 16); if (lo < 0xdc00 || lo > 0xdfff) fail();
          out += String.fromCharCode(u, lo);
        } else out += String.fromCharCode(u);
      } else {
        const m = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
        if (m === undefined) fail();
        out += m;
      }
    }
  };
  // Any JSON value (validated, discarded unless a string).
  const value = (depth) => {
    if (depth > 128) fail();
    ws();
    const c = s[i];
    if (c === '"') return { str: str() };
    if (c === '{') { i++; ws(); if (s[i] === '}') { i++; return {}; } for (;;) { ws(); str(); ws(); if (s[i++] !== ':') fail(); value(depth + 1); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return {}; } fail(); } }
    if (c === '[') { i++; ws(); if (s[i] === ']') { i++; return {}; } for (;;) { value(depth + 1); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return {}; } fail(); } }
    for (const lit of ['true', 'false', 'null']) if (s.startsWith(lit, i)) { i += lit.length; return {}; }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) fail();
    if (!Number.isFinite(Number(m[0]))) fail();
    i += m[0].length;
    return {};
  };
  ws();
  if (s[i] !== '{') fail();
  i++;
  const out = new Map();
  ws();
  if (s[i] === '}') i++;
  else {
    for (;;) {
      ws();
      const k = str(); ws();
      if (s[i++] !== ':') fail();
      const v = value(1);
      if (out.has(k)) fail();
      out.set(k, v);
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; break; }
      fail();
    }
  }
  ws();
  if (i < s.length) fail();
  return out;
}

// upstream: template_vars.rs::decode_and_validate → Map key → value (sorted by key)
export function decodeAndValidate(b64) {
  let bytes;
  try { bytes = B64.STANDARD.decode(trim(b64)); } catch { throw new TemplateVarError('Invalid'); }
  if (bytes.length > MAX_TEMPLATE_PAYLOAD_BYTES) throw new TemplateVarError('Invalid');
  let text;
  // std::str::from_utf8 keeps a leading U+FEFF, which serde_json rejects.
  try { text = decodeUtf8(bytes); } catch { throw new TemplateVarError('Invalid'); }
  const raw = parseObjectNoDup(text);
  const out = new Map();
  for (const key of [...raw.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (!TEMPLATE_VAR_WHITELIST.includes(key)) throw new TemplateVarError('Invalid');
    const v = raw.get(key);
    if (v.str === undefined) throw new TemplateVarError('Invalid');
    if (byteLen(v.str) > MAX_TEMPLATE_VALUE_LEN) throw new TemplateVarError('Invalid');
    out.set(key, v.str);
  }
  return out;
}

// upstream: template_vars.rs::render_one — single left-to-right pass, no rescanning.
function renderOne(content, vars) {
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (content.startsWith(PLACEHOLDER_OPEN, i)) {
      const close = content.indexOf(PLACEHOLDER_CLOSE, i + PLACEHOLDER_OPEN.length);
      if (close >= 0) {
        const key = content.slice(i + PLACEHOLDER_OPEN.length, close);
        if (vars.has(key)) { out += vars.get(key); i = close + PLACEHOLDER_CLOSE.length; continue; }
      }
    }
    const cp = content.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out += ch;
    i += ch.length;
  }
  return out;
}

// upstream: template_vars.rs::render_all (vars: Map)
export function renderAll(contents, vars) {
  for (const key of TEMPLATE_VAR_WHITELIST) {
    const ph = placeholderFor(key);
    const present = contents.some((c) => c.includes(ph));
    const supplied = vars.has(key);
    if (supplied && !present) throw new TemplateVarError('PlaceholderMissing');
    if (!supplied && present) throw new TemplateVarError('ValueMissing');
  }
  return contents.map((c) => renderOne(c, vars));
}
