// Available / unavailable / user-ignored Bitcoin UTXO views — upstream agentic_wallet/utxo/query.rs.
import { BtcApi } from '../shared/adapters/bitcoin/api.mjs';
import { BtcContext } from '../shared/adapters/bitcoin/context.mjs';
import { collectOutpoints } from '../shared/adapters/bitcoin/models.mjs';
import { isObject } from '../_rs.mjs';
import { pointer, recordOutpointKey } from './brc20.mjs';

// upstream: query.rs::UtxoQueryMode — { queryType, resultKey, message, section }
export const UtxoQueryMode = Object.freeze({
  UserIgnored: Object.freeze({
    queryType: 'USER_IGNORED_LIST', resultKey: 'userIgnored', section: '/userIgnoredList',
    message: 'Queried Bitcoin UTXOs whose asset occupancy was explicitly removed by the user.',
  }),
  Unavailable: Object.freeze({
    queryType: 'UNAVAILABLE_BREAKDOWN', resultKey: 'unavailable', section: '/unavailableBreakdown',
    message: 'Queried unavailable Bitcoin UTXO details and their current service reason categories.',
  }),
  Available: Object.freeze({
    queryType: 'AVAILABLE_UTXO_LIST', resultKey: 'available', section: '/availableUtxoList',
    message: 'Queried currently available Bitcoin UTXOs and their total spendable sats.',
  }),
});

// upstream: query.rs::UtxoQueryMode::collect_response_outpoints — the mode's own section
// (the whole snapshot when that section is absent).
export function collectResponseOutpoints(mode, snapshot) {
  const section = pointer(snapshot, mode.section);
  return collectOutpoints(section === undefined ? snapshot : section);
}

// upstream: query.rs::cmd_user_ignored
export const cmdUserIgnored = () => queryUtxos(UtxoQueryMode.UserIgnored);
// upstream: query.rs::cmd_unavailable
export const cmdUnavailable = () => queryUtxos(UtxoQueryMode.Unavailable);
// upstream: query.rs::cmd_available
export const cmdAvailable = () => queryUtxos(UtxoQueryMode.Available);

// upstream: query.rs::query_utxos → output data
export async function queryUtxos(mode) {
  const context = await BtcContext.load(null);
  const api = new BtcApi();
  const snapshot = await api.availabilityDetails(context, mode.queryType);
  const outpoints = collectResponseOutpoints(mode, snapshot);
  const assetRecords = await api.brc20UtxoAssetInfo(context, outpoints);
  enrichBrc20Assets(snapshot, assetRecords);
  return {
    message: mode.message,
    queryType: mode.queryType,
    outpointCount: outpoints.length,
    accountId: context.accountId,
    address: context.address.address,
    [mode.resultKey]: snapshot,
  };
}

// serde_json::Value::clone (F64 / BigInt leaves kept).
function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isObject(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = cloneValue(x); return o; }
  return v;
}

// upstream: query.rs::enrich_brc20_assets — non-empty asset lists onto the matching UTXO records.
export function enrichBrc20Assets(snapshot, assetRecords) {
  const byOutpoint = new Map();
  for (const record of assetRecords) {
    const assets = isObject(record) ? record.assets : undefined;
    if (!Array.isArray(assets) || !assets.length) continue;
    const key = recordOutpointKey(record);
    if (key !== undefined) byOutpoint.set(key, assets);
  }
  annotateUtxos(snapshot, byOutpoint);
  return snapshot;
}

// upstream: query.rs::annotate_utxos — recursive; every object whose txHash:voutIndex has
// bound assets gets `assets` (then its children, the inserted list included, are visited).
export function annotateUtxos(value, byOutpoint) {
  if (Array.isArray(value)) {
    for (const item of value) annotateUtxos(item, byOutpoint);
  } else if (isObject(value)) {
    const key = recordOutpointKey(value);
    if (key !== undefined && byOutpoint.has(key)) value.assets = cloneValue(byOutpoint.get(key));
    for (const k of Object.keys(value)) annotateUtxos(value[k], byOutpoint);
  }
}
