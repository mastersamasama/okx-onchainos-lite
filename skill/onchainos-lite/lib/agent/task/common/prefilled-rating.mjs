// Prefilled ASP rating cache — upstream task/common/prefilled_rating.rs.
// File: <home>/task/<jobId>/cache/prefilled-rating.json = pretty struct `{ "score", "comment" }`.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { taskStateDir } from '../../../core/home.mjs';
import { stringify, struct } from '../../../core/json.mjs';
import { fromStr, T } from '../../../core/serde.mjs';

const cacheDir = (jobId) => join(taskStateDir(jobId), 'cache');
const cachePath = (jobId) => join(cacheDir(jobId), 'prefilled-rating.json');
const RATING = T.struct('Rating', [['score', T.string], ['comment', T.string]]);

// upstream: prefilled_rating.rs::save
export function save(jobId, score, comment) {
  mkdirSync(cacheDir(jobId), { recursive: true });
  writeFileSync(cachePath(jobId), stringify(struct({ score, comment }), true));
}

// upstream: prefilled_rating.rs::get → { score, comment } | undefined
export function getPrefilled(jobId) {
  const path = cachePath(jobId);
  if (!existsSync(path)) return undefined;
  const r = fromStr(readFileSync(path), RATING);
  if (r.score === '') return undefined;
  return { score: r.score, comment: r.comment };
}
export { getPrefilled as get };

// upstream: prefilled_rating.rs::clear
export function clear(jobId) {
  const path = cachePath(jobId);
  if (existsSync(path)) rmSync(path);
}
