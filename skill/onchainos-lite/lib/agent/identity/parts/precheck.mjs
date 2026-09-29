// Registration pre-check (powers `agent pre-check`) — upstream
// commands/agent_commerce/identity/parts/precheck.rs (re-exported through ../utils.mjs).
import { trim, asciiLower } from '../../../core/rs/str.mjs';
import { isObject, numText, isNumber } from '../../../core/rs/value.mjs';
import { roleLabel, roleTokenFromValue } from '../utils.mjs';

const mget = (m, k) => (isObject(m) && Object.prototype.hasOwnProperty.call(m, k) && m[k] !== undefined ? m[k] : undefined);

// upstream: precheck.rs::role_key_from_value (private)
const roleKeyFromValue = (role) => roleTokenFromValue(role);

// upstream: precheck.rs::collect_owned_agents → [[agentId, roleKey | undefined, name]]
export function collectOwnedAgents(agentList, signingAddress) {
  const signingLower = asciiLower(trim(signingAddress));
  const ownerMatches = (node) => {
    const a = mget(node, 'ownerAddress');
    return typeof a === 'string' ? asciiLower(trim(a)) === signingLower : true;
  };
  const push = (row, out) => {
    const id = mget(row, 'agentId');
    let idStr;
    if (typeof id === 'string' && trim(id) !== '') idStr = trim(id);
    else if (isNumber(id)) idStr = numText(id);
    else return;
    const role = mget(row, 'role');
    const name = mget(row, 'name');
    out.push([idStr, role === undefined ? undefined : roleKeyFromValue(role), trim(typeof name === 'string' ? name : '')]);
  };
  const owned = [];
  const items = mget(agentList, 'list');
  if (Array.isArray(items)) {
    for (const item of items) {
      const rows = mget(item, 'agentList');
      if (Array.isArray(rows)) {
        if (ownerMatches(item)) for (const r of rows) push(r, owned);
      } else if (ownerMatches(item)) push(item, owned);
    }
  }
  return owned;
}

// upstream: precheck.rs::build_precheck — the pure verdict (json! → sorted keys)
export function buildPrecheck(agentList, signingAddress, roleKey) {
  const owned = collectOwnedAgents(agentList, signingAddress);
  const aspCount = owned.filter(([, rk]) => rk === 'asp').length;
  const existingSameRole = owned.filter(([, rk]) => rk === roleKey).map(([id, rk, name]) => ({
    agentId: id, name, roleLabel: (rk === undefined ? undefined : roleLabel(rk)) ?? '',
  }));
  const unique = roleKey === 'user' || roleKey === 'evaluator';
  const canCreate = unique ? existingSameRole.length === 0 : true;
  const label = roleLabel(roleKey) ?? roleKey;
  const out = {
    role: roleKey, roleLabel: label, ownerAddress: trim(signingAddress), uniqueness: unique ? 'single' : 'multiple',
    canCreate, existingSameRole, aspCount,
  };
  if (!canCreate) out.reason = `A ${label} is already registered under this wallet; each address can register only one ${label}.`;
  return out;
}
