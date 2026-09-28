// Permit2 allowance pre-check via direct `eth_call` — upstream payment/permit2/rpc.rs.
// Surfaces a clean "approve PERMIT2 first" prompt before signing instead of letting the
// facilitator's on-chain settle revert. Own HTTP client (10 s timeout), RPC from chains.rs.
import { STATUS_CODES } from 'node:http';
import { PERMIT2_ADDRESS, rpcUrlForChain } from '../../core/chains.mjs';
import { context } from '../../core/errors.mjs';
import { parse, stringify, struct } from '../../core/json.mjs';
import { keccak256 } from '../../crypto/keccak.mjs';
import { send } from '../_http.mjs';
import { addressFromStr, u256FromStrRadix, isObj, asI64, ReqwestError } from '../_rs.mjs';

const ALLOWANCE_SELECTOR = keccak256(Buffer.from('allowance(address,address)')).subarray(0, 4);   // 0xdd62ed3e
const RPC_TIMEOUT_MS = 10000;

// http::StatusCode Display: "<code> <canonical reason>"
const statusText = (s) => `${s} ${STATUS_CODES[s] ?? '<unknown status code>'}`;

// upstream: rpc.rs::fetch_permit2_allowance → BigInt (uint256)
export async function fetchPermit2Allowance(chainIndex, tokenAddress, ownerAddress) {
  const rpcUrl = rpcUrlForChain(chainIndex);
  if (!rpcUrl) throw new Error(`no RPC endpoint configured for chain ${chainIndex} — Permit2 allowance pre-check unavailable`);
  let token, owner;
  try { token = addressFromStr(tokenAddress); } catch (e) { throw context(`invalid token address: ${tokenAddress}`, e); }
  try { owner = addressFromStr(ownerAddress); } catch (e) { throw context(`invalid owner address: ${ownerAddress}`, e); }
  const spender = addressFromStr(PERMIT2_ADDRESS);
  const pad = (a) => Buffer.concat([Buffer.alloc(12), a]);
  const calldata = '0x' + Buffer.concat([ALLOWANCE_SELECTOR, pad(owner), pad(spender)]).toString('hex');
  const reqBody = struct({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0x' + token.toString('hex'), data: calldata }, 'latest'], id: 1 });
  let resp;
  try {
    resp = await send({ method: 'POST', url: rpcUrl, headers: [['content-type', 'application/json']], body: stringify(reqBody), timeoutMs: RPC_TIMEOUT_MS });
  } catch (e) {
    throw context(`Permit2 allowance RPC POST to ${rpcUrl} failed`, e instanceof ReqwestError ? e : new Error(String(e?.message ?? e)));
  }
  if (resp.status < 200 || resp.status > 299) throw new Error(`Permit2 allowance RPC returned HTTP ${statusText(resp.status)} from ${rpcUrl}`);
  let body;
  try {
    body = parse(resp.body.toString('utf8'));
    if (!isObj(body)) throw new Error('invalid type');
    if (body.result !== undefined && body.result !== null && typeof body.result !== 'string') throw new Error('invalid type');
    if (body.error !== undefined && body.error !== null) {
      if (!isObj(body.error)) throw new Error('invalid type');
      if (body.error.code !== undefined && asI64(body.error.code) === undefined) throw new Error('invalid type');
      if (body.error.message !== undefined && typeof body.error.message !== 'string') throw new Error('invalid type');
    }
  } catch (e) {
    throw context('Permit2 allowance RPC returned non-JSON body', new Error(`error decoding response body`));
  }
  if (body.error !== undefined && body.error !== null) {
    throw new Error(`Permit2 allowance RPC error (code ${body.error.code ?? 0}): ${body.error.message ?? ''}`);
  }
  const resultHex = body.result ?? undefined;
  if (resultHex === undefined) throw new Error('Permit2 allowance RPC response missing `result` field');
  try { return parseUint256Hex(resultHex); } catch (e) { throw context(`Permit2 allowance RPC returned malformed uint256: ${resultHex}`, e); }
}

// upstream: rpc.rs::parse_uint256_hex — tolerates short / odd-length hex.
export function parseUint256Hex(s) {
  const stripped = s.startsWith('0x') ? s.slice(2) : s;
  if (stripped === '') throw new Error('empty uint256 hex');
  if (stripped.length > 64) throw new Error(`uint256 hex too long: ${stripped.length} chars (max 64)`);
  try { return u256FromStrRadix(stripped, 16); } catch (e) { throw context(`not hex: ${s}`, e); }
}
