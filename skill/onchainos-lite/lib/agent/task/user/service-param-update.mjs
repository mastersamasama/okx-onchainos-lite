// V2 buyer-side serviceParams update (provider clarification loop) — upstream
// task/user/service_param_update.rs. Round state lives under `$OKX_AGENT_TASK_HOME/task-params`
// (default `~/.okx-agent-task/task-params`), NOT the onchainos home.
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { rustJoin as join } from '../../../core/qr.mjs';
import { homedir } from 'node:os';
import { context } from '../../../core/errors.mjs';
import { stringify, struct, F64 } from '../../../core/json.mjs';
import { fromStr, T } from '../../../wallet/_serde-json.mjs';
import { trim, ioErrorText, isObj } from '../../_rs.mjs';

const MAX_SUCCESSFUL_ROUNDS = 3;
const io = (e) => (e?.code && e?.syscall ? new Error(ioErrorText(e)) : e);

// upstream: ServiceParamTaskType (value enum: `single` only)
export const ServiceParamTaskType = Object.freeze({ Single: 'single', asStr: (t) => t, path: (_t, client, jobId) => client.endpoint(jobId, 'serviceParam') });

// upstream: service_param_update.rs::validate_inputs → parsed serviceParams value
export function validateInputs(jobId, agentId, requestId, round, serviceParams) {
  if (trim(jobId) === '') throw new Error('jobId is required');
  if (trim(agentId) === '') throw new Error('--agent-id is required');
  if (trim(requestId) === '') throw new Error('--request-id is required');
  if (!(round >= 1 && round <= MAX_SUCCESSFUL_ROUNDS)) throw new Error(`--round must be between 1 and ${MAX_SUCCESSFUL_ROUNDS}`);
  if (trim(serviceParams) === '') throw new Error('--service-params must contain the complete updated parameters');
  try { return fromStr(serviceParams); } catch (e) { throw context('--service-params must be one complete JSON value', e); }
}

// upstream: service_param_update.rs::state_root
export function stateRoot() {
  const env = process.env.OKX_AGENT_TASK_HOME;
  if (env !== undefined) return join(env, 'task-params');
  return join(homedir(), '.okx-agent-task', 'task-params');
}

// upstream: service_param_update.rs::state_path — lowercase hex of the jobId's UTF-8 bytes.
export const statePath = (root, jobId) => join(root, `${Buffer.from(String(jobId), 'utf8').toString('hex')}.json`);

const ROUND_STATE = T.struct('RoundState', [['successfulUpdates', T.vec(T.struct('SuccessfulUpdate', [['requestId', T.string], ['round', T.i64], ['serviceParams', T.value]]))]]);

// upstream: service_param_update.rs::read_state
function readState(path) {
  let bytes;
  try { bytes = readFileSync(path); } catch (e) {
    if (e?.code === 'ENOENT') return { successfulUpdates: [] };
    throw context(`read task-params state ${path}`, io(e));
  }
  try {
    const s = fromStr(bytes, ROUND_STATE);
    for (const u of s.successfulUpdates) {
      if (typeof u.round !== 'number' || u.round < 0 || u.round > 255) throw new Error(`invalid value: integer \`${u.round}\`, expected u8`);
    }
    return s;
  } catch (e) { throw context(`parse task-params state ${path}`, e); }
}

// upstream: RoundState Serialize (to_vec_pretty, struct order)
const roundStateStruct = (s) => struct({ successfulUpdates: s.successfulUpdates.map((u) => struct({ requestId: u.requestId, round: u.round, serviceParams: u.serviceParams })) });

// upstream: service_param_update.rs::write_state
function writeState(path, state) {
  const temp = path.replace(/\.json$/, '.json.tmp');
  try { writeFileSync(temp, stringify(roundStateStruct(state), true)); } catch (e) { throw context(`write task-params state ${temp}`, io(e)); }
  try { renameSync(temp, path); } catch (e) { throw context(`commit task-params state ${path}`, io(e)); }
}

// serde_json::Value PartialEq (integers and floats are distinct variants; maps are unordered).
export function valueEq(a, b) {
  const isInt = (v) => typeof v === 'number' || typeof v === 'bigint';
  if (a instanceof F64 || b instanceof F64) return a instanceof F64 && b instanceof F64 && a.valueOf() === b.valueOf();
  if (isInt(a) || isInt(b)) return isInt(a) && isInt(b) && BigInt(a) === BigInt(b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => valueEq(x, b[i]));
  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && valueEq(a[k], b[k]));
  }
  return a === b;
}

// upstream: service_param_update.rs::validate_round → existing entry | undefined
export function validateRound(state, requestId, round, serviceParams) {
  const existing = state.successfulUpdates.find((e) => e.requestId === requestId);
  if (existing) {
    if (existing.round !== round || !valueEq(existing.serviceParams, serviceParams)) throw new Error('requestId was already used with different round or serviceParams');
    return existing;
  }
  const successful = Math.min(state.successfulUpdates.length, 255);
  if (successful >= MAX_SUCCESSFUL_ROUNDS) throw new Error('three successful task-parameter updates already completed; provider must accept or decline');
  const expected = successful + 1;
  if (round !== expected) throw new Error(`--round must be the next successful round (${expected})`);
  return undefined;
}

// upstream: service_param_update.rs::handle → success data
export async function handle(client, jobId, agentId, taskType, requestIdRaw, round, serviceParams) {
  const parsed = validateInputs(jobId, agentId, requestIdRaw, round, serviceParams);
  const requestId = trim(requestIdRaw);
  const root = stateRoot();
  try { mkdirSync(root, { recursive: true }); } catch (e) { throw context(`create task-params state directory ${root}`, io(e)); }
  const path = statePath(root, jobId);
  const lockPath = path.replace(/\.json$/, '.lock');
  // fs2 exclusive lock: the lock file is created (and kept) exactly as upstream; Node has no
  // advisory flock, so concurrent invocations are not serialised.
  try { closeSync(openSync(lockPath, 'a')); } catch (e) { throw context(`open task-params lock ${lockPath}`, io(e)); }
  const state = readState(path);
  const params = { jobId, taskType: ServiceParamTaskType.asStr(taskType), requestId, round, serviceParams: parsed };
  if (validateRound(state, requestId, round, parsed)) {
    return {
      phase: 'task_params_update', decision: 'ready', reason: 'duplicate_request_already_confirmed',
      nextAction: [{ id: 'send_task_params_response', recommend: true, params }],
      payload: { jobId, requestId, round, successfulRounds: state.successfulUpdates.length, backendUpdated: true, duplicate: true },
    };
  }
  let response;
  try {
    response = await client.postMutationWithIdentity(ServiceParamTaskType.path(taskType, client, jobId), { serviceParams: stringify(parsed) }, agentId);
  } catch (e) { throw context('serviceParam update failed or returned an unknown network result; do not send task_params_response', e); }
  if (response !== null && response !== undefined) {
    throw new Error(`serviceParam update returned unexpected data; do not send task_params_response: ${stringify(response)}`);
  }
  state.successfulUpdates.push({ requestId, round, serviceParams: parsed });
  writeState(path, state);
  return {
    phase: 'task_params_update', decision: 'ready', reason: 'backend_update_confirmed',
    nextAction: [{ id: 'send_task_params_response', recommend: true, params }],
    payload: {
      jobId, taskType: ServiceParamTaskType.asStr(taskType), requestId, round, successfulRounds: state.successfulUpdates.length,
      serviceParams: parsed, backendUpdated: true, duplicate: false,
    },
  };
}
