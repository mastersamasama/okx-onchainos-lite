// Private helpers shared by the g03 market-data command groups
// (market, signal, social, memepump, leaderboard, tracker). Not a handler file.
import { F64 } from '../../core/json.mjs';

// Rust Option::is_some for an optional CLI/MCP value (undefined/null ≡ None).
export const some = (v) => v !== undefined && v !== null;

// serde field name of a camelCase CLI option (`minTop10HoldingsPercent` → `min_top10_holdings_percent`).
export const snakeCase = (camel) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// Build a Rust `*Params` struct (serde snake_case field names, None → null) from the parsed CLI
// options — what upstream's execute() does when it moves the clap fields into the struct.
// Shared fetch functions read ONLY these serde names, exactly like serde deserialising MCP args.
export function rustParams(o, camelNames) {
  const p = {};
  for (const n of camelNames) p[snakeCase(n)] = some(o[n]) ? o[n] : null;
  return p;
}

// serde_json Value::is_object / as_object_mut — a JSON object (not array, number, string, null).
export const isJsonObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64) && typeof v !== 'bigint';
