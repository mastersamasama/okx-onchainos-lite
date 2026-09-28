// Prefilled notify cache — upstream task/common/prefilled_notify.rs.
// File: <home>/task/<jobId>/cache/prefilled-notify.json = pretty sorted `{ "<event_key>": "<content>" }`.
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { taskStateDir } from '../../_home.mjs';
import { parse as parseJson, stringify } from '../../../core/json.mjs';
import { isObj, get, asStr, readToString } from '../../_rs.mjs';

const cacheDir = (jobId) => join(taskStateDir(jobId), 'cache');
const cachePath = (jobId) => join(cacheDir(jobId), 'prefilled-notify.json');

// upstream: prefilled_notify.rs::save
export function save(jobId, eventKey, content) {
  mkdirSync(cacheDir(jobId), { recursive: true });
  const path = cachePath(jobId);
  let map = {};
  if (existsSync(path)) {
    const raw = readToString(path);
    try { const v = parseJson(raw); map = isObj(v) ? v : {}; } catch { map = {}; }
  }
  // Map::insert — an own data property even for keys such as `__proto__`.
  Object.defineProperty(map, eventKey, { value: content, enumerable: true, writable: true, configurable: true });
  writeFileSync(path, stringify(map, true));
}

// upstream: prefilled_notify.rs::get → non-empty string | undefined
export function getPrefilled(jobId, eventKey) {
  const path = cachePath(jobId);
  if (!existsSync(path)) return undefined;
  const v = parseJson(readToString(path));
  const s = asStr(get(v, eventKey));
  return s !== undefined && s !== '' ? s : undefined;
}
export { getPrefilled as get };

// upstream: prefilled_notify.rs::clear
export function clear(jobId) {
  const path = cachePath(jobId);
  if (existsSync(path)) rmSync(path);
}
