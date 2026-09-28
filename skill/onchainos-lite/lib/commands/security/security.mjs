// security — upstream commands/security.rs: token-scan (explicit / public address / logged-in
// wallet), dapp-scan, tx-scan (EVM & Solana), approvals, sig-scan. Risk classification comes
// from core/risk-classify.mjs (upstream commands/risk_classify.rs).
import { resolveChain, chainFamily } from '../../core/chains.mjs';
import { ApiClient } from '../../core/http.mjs';
import * as E from '../../core/errors.mjs';
import { stringify, F64 } from '../../core/json.mjs';
import { fromStrValue } from './_serde-value.mjs';
import * as keyring from '../../core/keyring.mjs';
import { trim } from '../../core/_rust-str.mjs';
import { TokenResult, combinedAction, parseTradeDirectionValue } from '../../core/risk-classify.mjs';
import { WalletApiClient } from '../../wallet/api.mjs';
import { loadWallets } from '../../wallet/store.mjs';
import { getAllChains, getRealChainIndex } from '../../wallet/chain.mjs';
import { resolveActiveAccountId } from '../../wallet/account.mjs';
import { SECURITY_SOURCE } from '../token/token.mjs';
import { clap } from '../token/_clap.mjs';

// upstream: security.rs::BATCH_SIZE — max tokens per token-scan request.
export const BATCH_SIZE = 50;

const TOKEN_SCAN_PATH = '/api/v6/security/token-scan';
const DAPP_SCAN_PATH = '/api/v6/security/dapp-scan';
const TX_SCAN_SOL_PATH = '/api/v6/security/transaction-scan/sol';
const TX_SCAN_EVM_PATH = '/api/v6/security/transaction-scan/evm';
const APPROVAL_PATH = '/api/v6/security/approval-mng';
const SIGN_CHECK_PATH = '/api/v6/security/sign-message-check';
const ALL_BALANCES_PATH = '/api/v6/dex/balance/all-token-balances-by-address';
const WALLET_BALANCES_PATH = '/priapi/v5/wallet/agentic/asset/wallet-all-token-balances';

export const VALID_SIG_METHODS = ['personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4'];
const U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -9223372036854775808n, I64_MAX = 9223372036854775807n;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof F64);
const field = (v, k) => (isObj(v) && Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined);
const inI64 = (b) => b >= I64_MIN && b <= I64_MAX;
const toNum = (b) => (Number.isSafeInteger(Number(b)) ? Number(b) : b);

// anyhow `.context(msg)`: main.rs still downcasts through it to the special result types, so
// those keep their class (stdout unchanged); plain errors render as "msg: cause". The audit log
// records `{e:#}` = "msg: <inner Display>" in both cases: special types whose stdout does not
// come from `message` get the prefix there; for the ones printing `message` it cannot be both.
const SPECIAL = [E.WalletPreviewConfirming, E.Confirming, E.SetupRequired, E.FundingBlocked, E.DuplicateSubscription, E.CodedError, E.InsufficientBalance, E.BespokeExit, E.UsageError];
const PRINTS_MESSAGE = [E.CodedError, E.InsufficientBalance, E.UsageError];
function withContext(msg, e) {
  if (!SPECIAL.some((C) => e instanceof C)) return E.context(msg, e);
  if (!PRINTS_MESSAGE.some((C) => e instanceof C)) e.message = `${msg}: ${e.message}`;
  return e;
}

// keyring_store::get — a missing key is an error.
function keyringGet(key) {
  const v = keyring.get(key);
  if (v === undefined || v === null) throw new Error(`keyring key '${key}' not found`);
  return v;
}

// upstream: security.rs::token_scan_explicit (closure) — "chainId:contractAddress,…" → tokenList;
// the first malformed item (no ':') is an error.
export function parseExplicitTokens(tokens) {
  return String(tokens).split(',').map((raw) => {
    const item = trim(raw);
    const colon = item.indexOf(':');
    if (colon < 0) throw new Error(`Invalid token format '${item}'. Expected chainId:contractAddress (e.g. 1:0xdAC1...)`);
    return { chainId: resolveChain(trim(item.slice(0, colon))), contractAddress: trim(item.slice(colon + 1)) };
  });
}

// upstream: security.rs::extract_token_pairs — [[chainIndex, tokenContractAddress], …] read from
// the top-level items; native (empty address) and incomplete items skipped; other shapes error.
export function extractTokenPairs(data) {
  if (data === null || data === undefined) return [];
  let items;
  if (Array.isArray(data)) items = data;
  else {
    const wrapped = field(data, 'tokenAssets');
    if (!Array.isArray(wrapped)) {
      const text = stringify(data);
      const preview = [...text].slice(0, 200).join('');
      throw new Error(`Unexpected portfolio response format — expected array or {tokenAssets:[...]} but got: ${preview}${Buffer.byteLength(text) > 200 ? '…' : ''}`);
    }
    items = wrapped;
  }
  const pairs = [];
  for (const item of items) {
    const chainIndex = field(item, 'chainIndex');
    const address = field(item, 'tokenContractAddress');
    if (typeof chainIndex !== 'string' || typeof address !== 'string' || address === '') continue;
    pairs.push([chainIndex, address]);
  }
  return pairs;
}

// upstream: security.rs::classify_tokens — each object token gains normalizedRiskLevel / action /
// isNative (overwriting same-named keys); a json! object → keys print sorted.
export function classifyTokens(tokens, tradeDirection) {
  const classified = tokens.map((t) => TokenResult.classify(t, tradeDirection));
  const combined = combinedAction(classified);
  const enriched = tokens.map((token, i) => {
    if (isObj(token)) {
      token.normalizedRiskLevel = classified[i].normalizedRiskLevel();
      token.action = classified[i].action();
      token.isNative = classified[i].isNative();
    }
    return token;
  });
  return { tokens: enriched, combinedAction: combined, tradeDirection };
}

// upstream: security.rs::emit_token_scan — returns the `data` it prints: the classified object
// with a trade direction, else the raw array.
export const emitTokenScan = (results, tradeDirection) =>
  (tradeDirection === undefined ? results : classifyTokens(results, tradeDirection));

// upstream: security.rs::token_scan_explicit
async function tokenScanExplicit(ctx, tokens, tradeDirection) {
  const client = await ctx.api();
  const tokenList = parseExplicitTokens(tokens);
  if (!tokenList.length) throw new Error('--tokens must contain at least one chainId:contractAddress pair');
  if (tokenList.length > BATCH_SIZE) throw new Error(`--tokens supports at most ${BATCH_SIZE} items per request`);
  const result = await client.post(TOKEN_SCAN_PATH, { source: SECURITY_SOURCE, tokenList });
  return Array.isArray(result) ? emitTokenScan(result, tradeDirection) : result;
}

// upstream: security.rs::fetch_tokens_from_wallet — authenticated wallet balance API.
async function fetchTokensFromWallet(accessToken, accountId, chain) {
  const walletClient = new WalletApiClient();
  const chainIndex = chain === undefined ? '' : resolveChain(chain);
  const query = [['accountId', accountId]];
  if (chainIndex !== '') query.push(['chains', chainIndex]);
  const data = await walletClient.getAuthed(WALLET_BALANCES_PATH, accessToken, query);
  return extractTokenPairs(data);
}

// upstream: security.rs::fetch_tokens_by_address — public portfolio API (filter=1: all tokens).
async function fetchTokensByAddress(ctx, address, chain) {
  const client = await ctx.api();
  const chainsParam = chain === undefined ? '' : resolveChain(chain);
  const query = [['address', address], ['filter', '1']];
  if (chainsParam !== '') query.push(['chains', chainsParam]);
  const data = await client.get(ALL_BALANCES_PATH, query);
  return extractTokenPairs(data);
}

// upstream: security.rs::run_batch_scan — one token-scan POST per 50 pairs through one fresh
// client (upstream serialises the batches behind a mutex); results merged in batch order.
async function runBatchScan(pairs, tradeDirection) {
  if (!pairs.length) return emitTokenScan([], tradeDirection);
  const client = await ApiClient.create();
  const all = [];
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const tokenList = pairs.slice(i, i + BATCH_SIZE).map(([chainId, contractAddress]) => ({ chainId, contractAddress }));
    const r = await client.post(TOKEN_SCAN_PATH, { source: SECURITY_SOURCE, tokenList });
    if (Array.isArray(r)) all.push(...r);
    else all.push(r);
  }
  return emitTokenScan(all, tradeDirection);
}

// upstream: security.rs::token_scan — mode by flags: --tokens | --address | logged-in wallet.
async function tokenScan(ctx, tokens, address, chain, tradeDirection) {
  if (tokens !== undefined) return tokenScanExplicit(ctx, tokens, tradeDirection);
  if (address !== undefined) return runBatchScan(await fetchTokensByAddress(ctx, address, chain), tradeDirection);
  const wallets = loadWallets();
  if (!wallets) throw new Error('Not logged in and no --address provided.\nProvide --address <wallet_addr> or login with `onchainos wallet login`.');
  const accountId = resolveActiveAccountId(wallets);
  let accessToken;
  try {
    accessToken = keyringGet('access_token');
  } catch (e) {
    throw new Error(`Session expired or not logged in (${e.message}). Run \`onchainos wallet login\`.`);
  }
  return runBatchScan(await fetchTokensFromWallet(accessToken, accountId, chain), tradeDirection);
}

// upstream: security.rs::tx_scan (inline) — decimal --value → lowercase hex; 0x…/0X… and
// anything that is not a u128 pass through unchanged.
export function txScanHexValue(value) {
  if (value.startsWith('0x') || value.startsWith('0X')) return value;
  if (/^\+?[0-9]+$/.test(value)) {
    const n = BigInt(value.replace(/^\+/, ''));
    if (n <= U128_MAX) return `0x${n.toString(16)}`;
  }
  return value;
}

// upstream: security.rs::approvals (inline) — chainIndex of a supported-chain entry as i64
// (JSON integer, or a string parsed as i64), else undefined.
export function chainIndexI64(entry) {
  const raw = field(entry, 'chainIndex');
  if ((typeof raw === 'number' && Number.isInteger(raw) && !Object.is(raw, -0)) || typeof raw === 'bigint') {
    return inI64(BigInt(raw)) ? raw : undefined;
  }
  if (typeof raw === 'string' && /^[+-]?[0-9]+$/.test(raw)) {
    const b = BigInt(raw);
    return inI64(b) ? toNum(b) : undefined;
  }
  return undefined;
}

// upstream: security.rs::approvals (inline) — addressList from --chain (chainIndex a JSON string),
// else every EVM-family chain of the supported-chain list (chainIndex a JSON number).
export async function approvalAddressList(address, chain) {
  if (chain !== undefined) {
    return chain.split(',').map((c) => trim(c)).filter((c) => c !== '').map((c) => ({ chainIndex: resolveChain(c), address }));
  }
  let all;
  try {
    all = await getAllChains();
  } catch (e) {
    throw withContext('Failed to load supported chain list', e);
  }
  const out = [];
  for (const c of all) {
    const ci = chainIndexI64(c);
    if (ci === undefined) continue;
    if (chainFamily(String(ci)) === 'evm') out.push({ chainIndex: ci, address });
  }
  return out;
}

// upstream: security.rs::sig_scan (inline) — `serde_json::from_str(message).unwrap_or_else(|_|
// json!(message))`: any JSON value serde_json accepts, else the raw string. serde_json's rules
// (surrogate escapes, recursion limit 128, `-0`, number range, `__proto__` keys) differ from
// core/json.mjs parse(), so a strict private parser decides.
export function parseSigMessage(message) {
  try {
    return fromStrValue(message);
  } catch {
    return message;
  }
}

export default {
  'security token-scan': {
    uses: ['tokens', 'address', 'chain', 'tradeDirection'],
    async run(ctx, o) {
      const { tradeDirection } = clap(ctx, o, {
        types: { tradeDirection: parseTradeDirectionValue },
        conflicts: [['tokens', 'address']],
      });
      return tokenScan(ctx, o.tokens, o.address, o.chain, tradeDirection);
    },
  },
  // upstream: security.rs::dapp_scan
  'security dapp-scan': {
    uses: ['domain'],
    async run(ctx, o) {
      clap(ctx, o);
      const client = await ctx.api();
      return client.post(DAPP_SCAN_PATH, { source: SECURITY_SOURCE, url: trim(o.domain) });
    },
  },
  // upstream: security.rs::tx_scan
  'security tx-scan': {
    uses: ['from', 'to', 'chain', 'data', 'value', 'gas', 'gasPrice', 'encoding', 'transactions'],
    async run(ctx, o) {
      const { gas, gasPrice } = clap(ctx, o, { types: { gas: 'u64', gasPrice: 'u64' }, leafRequired: ['chain'] });
      const chainIndex = resolveChain(o.chain);
      const family = chainFamily(chainIndex);
      const client = await ctx.api();
      if (family === 'solana') {
        if (o.encoding === undefined) throw new Error('--encoding is required for Solana');
        if (o.transactions === undefined) throw new Error('--transactions is required for Solana');
        const transactions = o.transactions.split(',').map((s) => trim(s));
        return client.post(TX_SCAN_SOL_PATH, { source: SECURITY_SOURCE, from: o.from, chainId: '501', encoding: o.encoding, transactions });
      }
      if (family === 'evm') {
        const realChainId = await getRealChainIndex(chainIndex);
        if (o.data === undefined) throw new Error('--data is required for EVM tx-scan');
        const body = { source: SECURITY_SOURCE, from: o.from, chainId: realChainId, data: o.data };
        if (o.to !== undefined) body.to = o.to;
        if (o.value !== undefined) body.value = txScanHexValue(o.value);
        if (gas !== undefined) body.gas = gas;
        if (gasPrice !== undefined) body.gasPrice = gasPrice;
        return client.post(TX_SCAN_EVM_PATH, body);
      }
      throw new Error(`Chain '${o.chain}' (family: ${family}) is not supported for security tx-scan. Only EVM and Solana chains are supported.`);
    },
  },
  // upstream: security.rs::approvals
  'security approvals': {
    uses: ['address', 'chain', 'limit', 'cursor'],
    async run(ctx, o) {
      const { limit, cursor } = clap(ctx, o, { types: { limit: 'u32', cursor: 'u64' } });
      const addressList = await approvalAddressList(o.address, o.chain);
      if (!addressList.length) throw new Error('No supported chains found');
      const body = { nested: false, limit, addressList };
      if (cursor !== undefined) body.cursor = cursor;
      const client = await ctx.api();
      try {
        return await client.post(APPROVAL_PATH, body);
      } catch (e) {
        throw withContext('Failed to fetch approvals', e);
      }
    },
  },
  // upstream: security.rs::sig_scan
  'security sig-scan': {
    uses: ['from', 'chain', 'sigMethod', 'message'],
    async run(ctx, o) {
      clap(ctx, o, { leafRequired: ['chain'] });
      const chainIndex = resolveChain(o.chain);
      const realChainId = await getRealChainIndex(chainIndex);
      if (!VALID_SIG_METHODS.includes(o.sigMethod)) {
        throw new Error(`Invalid --sig-method '${o.sigMethod}'. Must be one of: ${VALID_SIG_METHODS.join(', ')}`);
      }
      const body = { source: SECURITY_SOURCE, from: o.from, chainId: realChainId, signType: o.sigMethod, message: parseSigMessage(o.message) };
      const client = await ctx.api();
      return client.post(SIGN_CHECK_PATH, body);
    },
  },
};
