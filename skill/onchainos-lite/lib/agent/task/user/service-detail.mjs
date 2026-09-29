// Fetch one current marketplace Service for task creation — upstream task/user/service_detail.rs.
import { stringify } from '../../../core/json.mjs';
import { get, asStr, asI64, asU64, asArray } from '../../../core/rs/value.mjs';
import { trim } from '../../../core/rs/str.mjs';

const SERVICE_DETAIL_PATH = '/priapi/v1/aieco/task/asp/service/search';

// upstream: service_detail.rs::scalar_string (private) — trimmed non-empty string or an integer.
export function scalarString(value) {
  if (value === undefined) return undefined;
  const s = asStr(value);
  if (s !== undefined) { const t = trim(s); if (t !== '') return t; }
  const i = asI64(value);
  if (i !== undefined) return String(i);
  const u = asU64(value);
  return u !== undefined ? String(u) : undefined;
}

// upstream: service_detail.rs::handle_service_detail → the matched Service object (success data)
export async function handleServiceDetail(client, sidRaw, agenticIdRaw) {
  const sid = trim(sidRaw);
  if (sid === '') throw new Error('--sid must not be blank');
  const agenticId = trim(agenticIdRaw);
  if (agenticId === '') throw new Error('--agentic-id must not be blank');
  const body = Buffer.from(stringify({ sid, limit: 1 }), 'utf8');
  const data = await client.rawPostWithIdentity(SERVICE_DETAIL_PATH, body, 'application/json', agenticId);
  const services = asArray(get(data, 'services'));
  if (!services) throw new Error('service detail response is missing services');
  const service = services.find((s) => scalarString(get(s, 'sid')) === sid);
  if (service === undefined) throw new Error(`service detail returned no Service matching sid \`${sid}\``);
  return service;
}
