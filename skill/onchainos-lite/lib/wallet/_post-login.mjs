// PRIVATE FALLBACK — post-login collaborators owned by the agent units, used by
// lib/wallet/auth.mjs only while these modules do not exist yet:
//   lib/agent/chat/index.mjs::fetchHeartbeat                 (agent_commerce/chat/mod.rs)
//   lib/agent/task/user/index.mjs::resolvePostLoginAgenticId  (agent_commerce/task/user/mod.rs)
//   lib/agent/task/user/index.mjs::preparePostLoginSubscriptions / finalizePostLoginSubscriptions
// auth.mjs prefers the owner's module whenever it loads and exports the function.
import { runSelf } from '../core/proc.mjs';
import * as store from './store.mjs';
import { resolveActiveAccountId } from './account.mjs';
import { isObject } from './_rs.mjs';

const HEARTBEAT_PATH = '/priapi/v5/wallet/agentic/agent-heartbeat';
const XLAYER_CHAIN_INDEX = '196';
const AGENT_ROLE_USER = 1;

// upstream: agent_commerce/chat/mod.rs::fetch_heartbeat
export function fetchHeartbeat(client, accessToken, chainIndex) {
  return client.postAuthed(HEARTBEAT_PATH, accessToken, { chainIndex: Number(chainIndex) });
}

// upstream: agent_commerce/task/common/mod.rs::current_account_xlayer_address
function currentAccountXlayerAddress() {
  let wallets;
  try { wallets = store.loadWallets(); } catch { return null; }
  if (!wallets) return null;
  let accountId;
  try { accountId = resolveActiveAccountId(wallets); } catch { return null; }
  const entry = wallets.accountsMap[accountId];
  if (!entry) return null;
  const a = entry.addressList.find((x) => x.chainIndex === XLAYER_CHAIN_INDEX);
  return a ? a.address.toLowerCase() : null;
}

// upstream: agent_commerce/task/common/mod.rs::flatten_agent_groups
function flattenAgentGroups(data) {
  if (Array.isArray(data) && isObject(data[0]) && data[0].agentId !== undefined) return data;
  let list = isObject(data) ? data.list : undefined;
  if (list === undefined && Array.isArray(data) && isObject(data[0])) list = data[0].list;
  if (!Array.isArray(list)) return [];
  const flat = [];
  for (const entry of list) {
    const agents = isObject(entry) ? entry.agentList : undefined;
    if (Array.isArray(agents)) {
      const owner = typeof entry.ownerAddress === 'string' ? entry.ownerAddress : undefined;
      const account = typeof entry.accountName === 'string' ? entry.accountName : undefined;
      for (const a of agents) {
        const agent = isObject(a) ? { ...a } : a;
        if (isObject(agent)) {
          if (!('ownerAddress' in agent) && owner !== undefined) agent.ownerAddress = owner;
          if (!('accountName' in agent) && account !== undefined) agent.accountName = account;
        }
        flat.push(agent);
      }
      continue;
    }
    if (isObject(entry) && entry.agentId !== undefined) flat.push(entry);
  }
  return flat;
}

// upstream: task/user/mod.rs::resolve_post_login_agentic_id → create.rs::resolve_user_agent →
// task/common::raw_query_my_agents (spawns `onchainos agent get-my-agents …`).
export async function resolvePostLoginAgenticId({ deadlineMs } = {}) {
  const owner = currentAccountXlayerAddress();
  if (!owner) throw new Error('no current XLayer address');
  const timeoutMs = deadlineMs ? Math.max(1, deadlineMs - Date.now()) : 30000;
  const r = await runSelf(['agent', 'get-my-agents', '--owner-address', owner, '--role', 'user', '--page-size', '100'], { timeoutMs });
  let body;
  try { body = JSON.parse(r.stdout); } catch (e) { throw new Error(`parse \`get-my-agents\` stdout failed: ${e.message}; raw=${r.stdout}`); }
  if (body?.ok !== true) throw new Error(`\`get-my-agents\` returned failure: ${typeof body?.error === 'string' ? body.error : '(no error)'}`);
  const agents = flattenAgentGroups(body.data ?? null);
  const user = agents.find((a) => isObject(a) && a.role === AGENT_ROLE_USER);
  if (!user) throw new Error('the current account has no user identity; run `onchainos agent create --role user` first');
  if (typeof user.agentId !== 'string') throw new Error('agent is missing the agentId field');
  return user.agentId;
}

// Subscription device routing (task/user/mod.rs::prepare_/finalize_post_login_subscriptions)
// needs the agent task client; without the agent module the optional step is skipped, which is
// the same outcome upstream produces when the preparation fails or times out.
export async function preparePostLoginSubscriptions() { return null; }
export async function finalizePostLoginSubscriptions() { return null; }
