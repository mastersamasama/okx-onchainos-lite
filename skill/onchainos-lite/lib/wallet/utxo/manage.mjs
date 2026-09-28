// Remove / restore Bitcoin UTXO asset protection (preview → `--operation-token … --force`) —
// upstream agentic_wallet/utxo/manage.rs.
import { CodedError } from '../../core/errors.mjs';
import { displayTop } from '../api.mjs';
import { WalletPreviewConfirming } from '../common.mjs';
import { BtcApi, UTXO_MANAGE_BATCH_SIZE } from '../shared/adapters/bitcoin/api.mjs';
import { BtcContext } from '../shared/adapters/bitcoin/context.mjs';
import { BtcOutPoint, collectOutpoints } from '../shared/adapters/bitcoin/models.mjs';
import { shellArg } from '../shared/common/json.mjs';
import { getField as get } from '../_rs.mjs';
import { asU64, parseU64, jcsStringify, sha256Hex, downcast } from '../shared/_rust.mjs';
import { pointer } from './brc20.mjs';

// upstream: manage.rs::cmd_unlock → output data (or WalletPreviewConfirming)
export function cmdUnlock(outpoints, all, operationToken, force) {
  if (all !== (outpoints.length === 0)) throw new Error('use exactly one of --outpoint or --all');
  return manage('ignoreAsset', 'btc_utxo_unlock', 'UNAVAILABLE_BREAKDOWN', [...outpoints], all, operationToken, force);
}

// upstream: manage.rs::cmd_lock → output data (or WalletPreviewConfirming)
export function cmdLock(outpoints, all, operationToken, force) {
  if (all !== (outpoints.length === 0)) throw new Error('use exactly one of --outpoint or --all');
  return manage('cancelIgnore', 'btc_utxo_lock', 'USER_IGNORED_LIST', [...outpoints], all, operationToken, force);
}

const some = (v) => v !== undefined && v !== null;

// upstream: manage.rs::manage — the shared protection flow.
export async function manage(action, scene, queryType, requestedOutpoints, all, operationToken, force) {
  validateManageContinuation(operationToken, force);
  const context = await BtcContext.load(null);
  const api = new BtcApi();
  const snapshot = await api.availabilityDetails(context, queryType);
  let candidates;
  if (queryType === 'UNAVAILABLE_BREAKDOWN') {
    if (all && hasGroupItems(snapshot, '/unavailableBreakdown/assetUncertain')) {
      throw new CodedError('INCOMPLETE_SNAPSHOT', null, 'All protected UTXOs cannot be unlocked while assetUncertain contains unresolved outpoints',
        { data: { assetUncertain: pointer(snapshot, '/unavailableBreakdown/assetUncertain') ?? null } });
    }
    const locked = collectProtectedOutpoints(snapshot, false);
    if (all && !locked.length && hasGroupItems(snapshot, '/unavailableBreakdown/assetLocked')) {
      throw new CodedError('INCOMPLETE_SNAPSHOT', null, 'assetLocked reports protected UTXOs without complete outpoints',
        { data: { assetLocked: pointer(snapshot, '/unavailableBreakdown/assetLocked') ?? null } });
    }
    candidates = locked;
  } else {
    const section = pointer(snapshot, '/userIgnoredList');
    candidates = collectOutpoints(section === undefined ? snapshot : section);
  }
  const targets = selectTargets(candidates, requestedOutpoints, all);
  const operationReason = resolveManagementReason(action);
  const operationType = resolveManagementOperationType(action);
  const canonicalTargets = targets.map((t) => t.canonical());

  const preview = {
    operationType,
    chainIndex: context.profile.chainIndex,
    network: 'bitcoin',
    from: context.address.address,
    targets: canonicalTargets,
    message: operationReason,
    snapshot,
  };
  const confirmationToken = buildManageConfirmationToken(operationType, context.profile.chainIndex, context.accountId, context.address.address, canonicalTargets);
  const targetFlags = targets.map((t) => ` --outpoint ${shellArg(t.canonical())}`).join('');
  const command = action === 'ignoreAsset' ? 'unlock' : 'lock';
  const next = `onchainos wallet utxo ${command} --chain bitcoin${targetFlags} --operation-token ${shellArg(confirmationToken)} --force`;

  if (force) {
    if (operationToken !== confirmationToken) {
      throw new WalletPreviewConfirming({
        message: 'The supplied UTXO confirmation does not match the current account, operation, or target outpoints. Review the refreshed preview before confirming again.',
        next, scene, preview,
      });
    }
    const batchResults = [];
    let executionError = null;
    for (let i = 0, batchIndex = 0; i < targets.length; i += UTXO_MANAGE_BATCH_SIZE, batchIndex++) {
      const batch = targets.slice(i, i + UTXO_MANAGE_BATCH_SIZE);
      let result;
      try { result = await api.manageUtxos(context, action, operationReason, batch); } catch (e) { executionError = e; break; }
      const normalized = normalizeManageBatchResult(result, batchIndex, batch);
      batchResults.push(normalized);
      if (normalized.result !== true) break;
    }
    const latestBreakdown = await api.availabilityDetails(context, 'UNAVAILABLE_BREAKDOWN');
    const latestIgnored = await api.availabilityDetails(context, 'USER_IGNORED_LIST');
    const resultContext = { batchResults, unavailable: latestBreakdown, userIgnored: latestIgnored };
    if (executionError) throw enrichManageError(executionError, resultContext);
    const failed = batchResults.filter((item) => item.result === false);
    if (failed.length) {
      const anySucceeded = batchResults.some((item) => item.result === true);
      throw new CodedError(anySucceeded ? 'UTXO_MANAGE_PARTIAL_FAILURE' : 'UTXO_MANAGE_REJECTED', null, 'One or more UTXO protection changes were rejected',
        { data: { batchResults, failed, unavailable: latestBreakdown, userIgnored: latestIgnored } });
    }
    return {
      message: action === 'ignoreAsset'
        ? 'UTXO asset protection was removed. The latest UTXO state is included.'
        : 'UTXO asset protection was restored. The latest UTXO state is included.',
      batchResults,
      targets: canonicalTargets,
      unavailable: latestBreakdown,
      userIgnored: latestIgnored,
    };
  }

  throw new WalletPreviewConfirming({
    message: `Review ${action === 'ignoreAsset' ? 'protection removal' : 'protection restoration'} for ${targets.length} UTXO(s). Every target and the latest availability snapshot are included in preview. Confirm only if changing protection for these UTXOs is acceptable.`,
    next, scene, preview,
  });
}

// upstream: manage.rs::resolve_management_reason
export function resolveManagementReason(action) {
  if (action === 'ignoreAsset') return 'User confirmed removal of UTXO asset protection';
  if (action === 'cancelIgnore') return 'User confirmed restoration of UTXO asset protection';
  throw new Error(`unsupported UTXO management action: ${action}`);
}

// upstream: manage.rs::resolve_management_operation_type
export function resolveManagementOperationType(action) {
  if (action === 'ignoreAsset') return 'UNLOCK_UTXO_PROTECTION';
  if (action === 'cancelIgnore') return 'LOCK_UTXO_PROTECTION';
  throw new Error(`unsupported UTXO management action: ${action}`);
}

// upstream: manage.rs::validate_manage_continuation
export function validateManageContinuation(operationToken, force) {
  if (force && !some(operationToken)) throw new Error('confirmed UTXO protection changes require the preview continuation');
  if (!force && some(operationToken)) throw new Error('preview continuation parameters are only valid with --force');
  if (!force) return;
  if (!isConfirmationToken(operationToken)) {
    throw new CodedError('INVALID_PREVIEW_CONTINUATION', 'operationToken',
      'Invalid UTXO preview continuation: --operation-token must be the sha256 token returned by the preview');
  }
}

// upstream: manage.rs::is_confirmation_token — `sha256:` + 64 hex digits.
export const isConfirmationToken = (value) => typeof value === 'string' && value.startsWith('sha256:') && /^[0-9a-fA-F]{64}$/.test(value.slice(7));

// upstream: manage.rs::build_manage_confirmation_token — sha256 over the JCS form of the
// critical intent (account, chain, sender, operation, targets).
export function buildManageConfirmationToken(operationType, chainIndex, accountId, from, targets) {
  const criticalIntent = { operationType, chainIndex, network: 'bitcoin', accountId, from, targets };
  return `sha256:${sha256Hex(jcsStringify(criticalIntent))}`;
}

// upstream: manage.rs::select_targets — `--all` → every candidate; else each requested outpoint
// must be unique and present, returned sorted by (txHash, vout).
export function selectTargets(available, requested, all) {
  if (all) {
    if (!available.length) throw new Error('no matching UTXOs were returned by the current service snapshot');
    return [...available];
  }
  if (!requested.length) throw new Error('at least one --outpoint is required');
  const unique = new Set();
  const targets = [];
  for (const raw of requested) {
    const point = BtcOutPoint.parse(raw);
    const canonical = point.canonical();
    if (unique.has(canonical)) throw new Error(`duplicate --outpoint ${canonical}`);
    unique.add(canonical);
    const target = available.find((c) => c.txHash === point.txHash && c.voutIndex === point.voutIndex);
    if (!target) throw new CodedError('STATE_CHANGED', 'outpoint', `The requested outpoint ${canonical} is not present in the latest UTXO snapshot`);
    targets.push(target);
  }
  return targets.sort(BtcOutPoint.compare);
}

// upstream: manage.rs::collect_protected_outpoints
export function collectProtectedOutpoints(snapshot, includeUncertain) {
  const locked = pointer(snapshot, '/unavailableBreakdown/assetLocked');
  let points = locked === undefined ? [] : collectOutpoints(locked);
  if (includeUncertain) {
    points = [...points, ...collectUncertainOutpoints(snapshot)].sort(BtcOutPoint.compare)
      .filter((p, i, arr) => i === 0 || BtcOutPoint.compare(p, arr[i - 1]) !== 0);
  }
  return points;
}

// upstream: manage.rs::collect_uncertain_outpoints
export function collectUncertainOutpoints(snapshot) {
  const group = pointer(snapshot, '/unavailableBreakdown/assetUncertain');
  return group === undefined ? [] : collectOutpoints(group);
}

// upstream: manage.rs::has_group_items — `count` > 0 (u64 or numeric string) or any outpoint.
export function hasGroupItems(snapshot, path) {
  const group = pointer(snapshot, path);
  if (group === undefined) return false;
  const c = get(group, 'count');
  const count = c === undefined ? undefined : asU64(c) ?? (typeof c === 'string' ? parseU64(c) : undefined);
  return (count !== undefined && count > 0n) || collectOutpoints(group).length > 0;
}

// upstream: manage.rs::normalize_manage_batch_result
export function normalizeManageBatchResult(result, batchIndex, targets) {
  if (!Array.isArray(result)) throw new Error('UTXO management response data must be an array');
  if (result.length !== 1) throw new Error('UTXO management response data must contain exactly one item');
  const item = result[0];
  const succeeded = get(item, 'result');
  if (typeof succeeded !== 'boolean') throw new Error('UTXO management response item is missing boolean result');
  let reason = get(item, 'reason');
  if (reason === undefined) reason = get(item, 'resaon');
  return { batchIndex, outpoints: targets.map((t) => t.canonical()), result: succeeded, reason: reason === undefined ? null : reason };
}

// upstream: manage.rs::enrich_manage_error — a service CodedError gets the operation context
// (its own data moves to `serviceData`); anything else is an unknown result.
export function enrichManageError(error, context) {
  const coded = downcast(error, CodedError);
  if (coded) {
    const ctx = { ...context };
    if (coded.data !== undefined && coded.data !== null) ctx.serviceData = coded.data;
    coded.data = ctx;
    return coded;
  }
  return new CodedError('UTXO_MANAGE_RESULT_UNKNOWN', null, `UTXO management result is unknown: ${displayTop(error)}`, { data: context });
}

