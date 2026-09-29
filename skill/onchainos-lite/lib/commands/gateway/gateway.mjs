// gateway — upstream commands/gateway.rs: gas price / gas limit / simulate / broadcast /
// order tracking / supported chains. The fetch* exports mirror upstream's pub fns (MCP, swap).
// `broadcast` is fund-moving: it submits the caller's signed transaction exactly once
// (post_no_retry_with_headers — no payment pre-sign, no 402/token/network retry).
import { resolveChain } from '../../core/chains.mjs';
import { getSwapTraceId } from '../../wallet/store.mjs';

const GAS_PRICE_PATH = '/api/v6/dex/pre-transaction/gas-price';
const GAS_LIMIT_PATH = '/api/v6/dex/pre-transaction/gas-limit';
const SIMULATE_PATH = '/api/v6/dex/pre-transaction/simulate';
const BROADCAST_PATH = '/api/v6/dex/pre-transaction/broadcast-transaction';
const ORDERS_PATH = '/api/v6/dex/post-transaction/orders';
const SUPPORTED_CHAIN_PATH = '/api/v6/dex/pre-transaction/supported/chain';

// upstream: gateway.rs::fetch_gas — GET /api/v6/dex/pre-transaction/gas-price
export async function fetchGas(client, chainIndex) {
  return client.get(GAS_PRICE_PATH, [['chainIndex', chainIndex]]);
}

// upstream: gateway.rs::fetch_gas_limit — POST /api/v6/dex/pre-transaction/gas-limit
export async function fetchGasLimit(client, chainIndex, from, to, amount, data) {
  const body = { chainIndex, fromAddress: from, toAddress: to, txAmount: amount };
  if (data !== undefined && data !== null) body.extJson = { inputData: data };
  return client.post(GAS_LIMIT_PATH, body);
}

// upstream: gateway.rs::fetch_simulate — POST /api/v6/dex/pre-transaction/simulate
export async function fetchSimulate(client, chainIndex, from, to, amount, data) {
  return client.post(SIMULATE_PATH, { chainIndex, fromAddress: from, toAddress: to, txAmount: amount, extJson: { inputData: data } });
}

// upstream: gateway.rs::fetch_broadcast (body) — extraData is a JSON-encoded *string*.
export function broadcastBody(chainIndex, signedTx, address, mevProtection) {
  const body = { signedTx, chainIndex, address };
  if (mevProtection) body.extraData = '{"enableMevProtection":true}';
  return body;
}

// wallet_store::get_swap_trace_id().ok().flatten() — read errors ignored.
function cachedSwapTraceId() {
  try {
    return getSwapTraceId() ?? null;
  } catch {
    return null;
  }
}

// upstream: gateway.rs::fetch_broadcast — POST …/broadcast-transaction once; a cached swap trace
// id adds `ok-client-tid` + `ok-client-timestamp` (Unix ms) headers (the id is not cleared).
export async function fetchBroadcast(client, chainIndex, signedTx, address, mevProtection) {
  const body = broadcastBody(chainIndex, signedTx, address, mevProtection);
  const tid = cachedSwapTraceId();
  const headers = tid !== null ? { 'ok-client-tid': tid, 'ok-client-timestamp': String(Date.now()) } : undefined;
  return client.postNoRetry(BROADCAST_PATH, body, headers);
}

// upstream: gateway.rs::fetch_orders — GET /api/v6/dex/post-transaction/orders
export async function fetchOrders(client, chainIndex, address, orderId) {
  const query = [['address', address], ['chainIndex', chainIndex]];
  if (orderId !== undefined && orderId !== null) query.push(['orderId', orderId]);
  return client.get(ORDERS_PATH, query);
}

// upstream: gateway.rs::fetch_chains — GET /api/v6/dex/pre-transaction/supported/chain
export async function fetchChains(client) {
  return client.get(SUPPORTED_CHAIN_PATH, []);
}

export default {
  'gateway gas': {
    uses: ['chain'],
    async run(ctx, o) {
      const chainIndex = resolveChain(o.chain);
      const client = await ctx.api();
      return fetchGas(client, chainIndex);
    },
  },
  'gateway gas-limit': {
    uses: ['from', 'to', 'amount', 'data', 'chain'],
    async run(ctx, o) {
      const chainIndex = resolveChain(o.chain);
      const client = await ctx.api();
      return fetchGasLimit(client, chainIndex, o.from, o.to, o.amount, o.data);
    },
  },
  'gateway simulate': {
    uses: ['from', 'to', 'amount', 'data', 'chain'],
    async run(ctx, o) {
      const chainIndex = resolveChain(o.chain);
      const client = await ctx.api();
      return fetchSimulate(client, chainIndex, o.from, o.to, o.amount, o.data);
    },
  },
  'gateway broadcast': {
    uses: ['signedTx', 'address', 'chain', 'mevProtection'],
    async run(ctx, o) {
      const chainIndex = resolveChain(o.chain);
      const client = await ctx.api();
      return fetchBroadcast(client, chainIndex, o.signedTx, o.address, o.mevProtection);
    },
  },
  'gateway orders': {
    uses: ['address', 'chain', 'orderId'],
    async run(ctx, o) {
      const chainIndex = resolveChain(o.chain);
      const client = await ctx.api();
      return fetchOrders(client, chainIndex, o.address, o.orderId);
    },
  },
  'gateway chains': {
    uses: [],
    async run(ctx) {
      const client = await ctx.api();
      return fetchChains(client);
    },
  },
};
