// Bitcoin outpoints and read-only continuation commands —
// upstream agentic_wallet/shared/adapters/bitcoin/models.rs.
import { shellArg } from '../../common/json.mjs';
import { trim, cmpBytes } from '../../../../core/rs/str.mjs';
import { get, isObject, asU64 } from '../../../../core/rs/value.mjs';
import { parseU64 } from '../../../../core/rs/num.mjs';

// rust-bitcoin 0.32 OutPoint::from_str — returns [txidLowercase, vout] or throws the crate's
// ParseOutPointError Display text.
function parseOutPoint(s) {
  const bytes = Buffer.from(s, 'utf8');
  if (bytes.length > 75) throw new Error('vout should be at most 10 digits');
  const colon = bytes.indexOf(0x3a);
  if (colon < 0 || colon !== bytes.lastIndexOf(0x3a)) throw new Error('OutPoint not in <txid>:<vout> format');
  if (colon === 0 || colon === bytes.length - 1) throw new Error('OutPoint not in <txid>:<vout> format');
  const txid = bytes.subarray(0, colon).toString('utf8');
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error('error parsing TXID');
  const vout = bytes.subarray(colon + 1).toString('utf8');
  if (Buffer.byteLength(vout) > 1 && (vout[0] === '0' || vout[0] === '+')) throw new Error('no leading zeroes or + allowed in vout part');
  const v = parseU64(vout);
  if (v === undefined || v > 4294967295n) throw new Error('error parsing vout');
  return [txid.toLowerCase(), Number(v)];
}

// upstream: models.rs::BtcOutPoint
export class BtcOutPoint {
  constructor(txHash, voutIndex) { this.txHash = txHash; this.voutIndex = voutIndex; }

  // upstream: models.rs::BtcOutPoint::parse — canonical lower-case txid.
  static parse(value) {
    let parsed;
    try { parsed = parseOutPoint(value); } catch (e) { throw new Error(`invalid outpoint '${value}': ${e.message}`); }
    return new BtcOutPoint(parsed[0], parsed[1]);
  }

  // upstream: models.rs::BtcOutPoint::canonical
  canonical() { return `${this.txHash}:${this.voutIndex}`; }

  // upstream: models.rs::BtcOutPoint::to_api_value
  toApiValue() { return { txHash: this.txHash, voutIndex: String(this.voutIndex) }; }

  // derive(Ord): (tx_hash, vout_index)
  static compare(a, b) { return cmpBytes(a.txHash, b.txHash) || a.voutIndex - b.voutIndex; }
}

// upstream: models.rs::ReadOnlyNextStep
export const ReadOnlyNextStep = Object.freeze({
  checkInscriptionStatus: ({ txHash, orderId } = {}) => ({ kind: 'CheckInscriptionStatus', txHash, orderId }),
  QueryUnavailableUtxos: Object.freeze({ kind: 'QueryUnavailableUtxos' }),
  ShowBitcoinAddress: Object.freeze({ kind: 'ShowBitcoinAddress' }),
  RefreshBtcBalance: Object.freeze({ kind: 'RefreshBtcBalance' }),
  queryBrc20TransferableUtxos: (tokenAddress) => ({ kind: 'QueryBrc20TransferableUtxos', tokenAddress }),
});

// upstream: models.rs::ReadOnlyNextStep::build_command_entry → [key, command]
function buildCommandEntry(step) {
  let pair;
  switch (step.kind) {
    case 'CheckInscriptionStatus':
      pair = ['checkInscriptionStatus', buildInscriptionStatusCommand(step.txHash, step.orderId)];
      break;
    case 'QueryUnavailableUtxos':
      pair = ['queryUnavailableUtxos', 'onchainos wallet utxo unavailable --chain bitcoin'];
      break;
    case 'ShowBitcoinAddress':
      pair = ['showBitcoinAddress', 'onchainos wallet addresses --chain bitcoin'];
      break;
    case 'RefreshBtcBalance':
      pair = ['refreshBtcBalance', 'onchainos wallet balance --chain bitcoin --force'];
      break;
    case 'QueryBrc20TransferableUtxos':
      if (trim(step.tokenAddress ?? '') === '') throw new Error('token address is required for a transferable BRC-20 UTXO query');
      pair = ['queryBrc20TransferableUtxos', `onchainos wallet utxo brc20-transferable --chain bitcoin --token-address ${shellArg(step.tokenAddress)}`];
      break;
    default:
      throw new Error(`unknown next step ${step.kind}`);
  }
  ensureReadOnlyCommand(pair[1]);
  return pair;
}

// upstream: models.rs::next_steps → { <action>: <command> } (a json! Value: sorted keys)
export function nextSteps(steps) {
  const map = {};
  for (const step of steps) {
    const [action, command] = buildCommandEntry(step);
    map[action] = command;
  }
  return map;
}

// upstream: models.rs::build_inscription_status_command
function buildInscriptionStatusCommand(txHash, orderId) {
  const tx = txHash ? txHash : undefined;
  const order = orderId ? orderId : undefined;
  if (tx !== undefined) return `onchainos wallet inscription status --chain bitcoin --tx-hash ${shellArg(tx)}`;
  if (order !== undefined) return `onchainos wallet inscription status --chain bitcoin --order-id ${shellArg(order)}`;
  throw new Error('txHash or orderId is required for a status continuation');
}

// upstream: models.rs::ensure_read_only_command
function ensureReadOnlyCommand(command) {
  const PREFIXES = [
    'onchainos wallet inscription status --chain bitcoin ',
    'onchainos wallet utxo unavailable --chain bitcoin',
    'onchainos wallet utxo brc20-transferable --chain bitcoin ',
    'onchainos wallet addresses --chain bitcoin',
    'onchainos wallet balance --chain bitcoin',
  ];
  if (PREFIXES.some((p) => command.startsWith(p))) return;
  throw new Error(`nextSteps rejected non-read-only command: ${command}`);
}

// upstream: models.rs::collect_outpoints — recursive, deduplicated, ordered by canonical text.
export function collectOutpoints(value) {
  const output = new Map();
  const visit = (v) => {
    if (isObject(v)) {
      let txHash;
      for (const k of ['txHash', 'txhash', 'txid', 'txId']) { const s = get(v, k); if (typeof s === 'string') { txHash = s; break; } }
      const voutKey = ['voutIndex', 'voutindex', 'vout'].find((k) => get(v, k) !== undefined);
      let vout;
      if (voutKey !== undefined) {
        const raw = get(v, voutKey);
        vout = asU64(raw) ?? (typeof raw === 'string' ? parseU64(raw) : undefined);
      }
      if (txHash !== undefined && vout !== undefined && vout <= 4294967295n) {
        const point = new BtcOutPoint(txHash, Number(vout));
        output.set(point.canonical(), point);
      }
      for (const k of Object.keys(v).sort(cmpBytes)) visit(v[k]);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x);
    }
  };
  visit(value);
  return [...output.keys()].sort(cmpBytes).map((k) => output.get(k));
}
