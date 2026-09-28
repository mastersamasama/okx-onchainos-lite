// Per-job user-language marker — upstream task/common/user_lang.rs.
// Files: <home>/autotrade/lang/<jobId> and <home>/autotrade/lang/_default (literal `zh` / `en`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { onchainosHome, writeSecure } from '../../_home.mjs';
import { splitWhitespace, trim } from '../../_rs.mjs';

// upstream: user_lang.rs::Lang
export const Lang = Object.freeze({ Zh: 'zh', En: 'en' });

const markerPath = (name) => join(onchainosHome(), 'autotrade', 'lang', name);
const jobIdOk = (j) => typeof j === 'string' && /^[A-Za-z0-9_-]+$/.test(j);
const ASCII_PUNCT = /^[!-\/:-@\[-`{-~]+|[!-\/:-@\[-`{-~]+$/g;

// upstream: user_lang.rs::detect → 'zh' | 'en' | undefined
export function detect(text) {
  let lower = 0;
  for (const token of splitWhitespace(text)) {
    if (/[一-鿿㐀-䶿]/.test(token)) return Lang.Zh;
    const t = token.replace(ASCII_PUNCT, '');
    if (t === '') continue;
    if (t.toLowerCase().startsWith('0x') || t.includes('://') || t.includes('@') || /^[0-9A-Fa-f]+$/.test(t)) continue;
    lower += (t.match(/[a-z]/g) || []).length;
  }
  return lower >= 3 ? Lang.En : undefined;
}

// upstream: user_lang.rs::record_from_user_text
export function recordFromUserText(jobId, text) {
  const lang = detect(text);
  if (lang !== undefined) record(jobId, lang);
}

// upstream: user_lang.rs::record
export function record(jobId, lang) {
  if (jobIdOk(jobId)) { try { writeSecure(markerPath(jobId), lang); } catch {} }
  try { writeSecure(markerPath('_default'), lang); } catch {}
}

// upstream: user_lang.rs::resolve
export function resolve(jobId) {
  const read = (name) => {
    let s;
    try { s = readFileSync(markerPath(name), 'utf8'); } catch { return undefined; }
    const t = trim(s);
    return t === 'zh' ? Lang.Zh : t === 'en' ? Lang.En : undefined;
  };
  if (jobIdOk(jobId)) { const l = read(jobId); if (l !== undefined) return l; }
  return read('_default') ?? Lang.En;
}
