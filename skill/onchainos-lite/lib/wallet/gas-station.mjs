// `wallet gas-station` management: default token, enable/disable flag, readiness status and
// standalone first-time setup — upstream agentic_wallet/gas_station.rs. (The Gas Station branch
// of `wallet send` / contract-call lives in lib/wallet/transfer/gas-station.mjs.)
// Every function returns the output data (upstream prints it with output::success).
import { resolveChain } from '../core/chains.mjs';
import { WalletApiClient, gsStatus, GasStationStatus } from './api.mjs';
import * as store from './store.mjs';
import { ensureTokensRefreshed, formatApiError } from './auth.mjs';
import { getChainByRealChainIndex } from './chain.mjs';
import { ERR_NOT_LOGGED_IN } from './common.mjs';
import { resolveAddress, cmdSend } from './transfer/index.mjs';
import { eqIgnoreAsciiCase } from '../core/rs/str.mjs';
import { isObject, get } from '../core/rs/value.mjs';
import { parseU64 } from '../core/rs/num.mjs';

// upstream: gas_station.rs::execute — cmd: { kind, chain, gasTokenAddress?, relayerId?, from? }
export function execute(cmd) {
  switch (cmd.kind) {
    case 'UpdateDefaultToken': return fetchUpdateDefaultToken(cmd.chain, cmd.gasTokenAddress);
    case 'Enable': return fetchUpdate(cmd.chain, true);
    case 'Disable': return fetchUpdate(cmd.chain, false);
    case 'Status': return cmdStatus(cmd.chain, cmd.from);
    case 'Setup': return cmdSetup(cmd.chain, cmd.gasTokenAddress, cmd.relayerId, cmd.from);
    default: throw new Error(`unknown gas-station command ${cmd.kind}`);
  }
}

// Resolve the chain entry's chainName (`unsupported chain: <raw>` / `chain entry missing chainName`).
async function chainNameFor(chainIndex, rawChain) {
  const entry = await getChainByRealChainIndex(chainIndex);
  if (!entry) throw new Error(`unsupported chain: ${rawChain}`);
  const name = get(entry, 'chainName');
  if (typeof name !== 'string') throw new Error('chain entry missing chainName');
  return name;
}

// upstream: gas_station.rs::build_gs_context → GsContext
// { accessToken, addrInfo, chainName, chainIndexResolved, chainIndexNum, sessionCert }
export async function buildGsContext(chain, from) {
  const accessToken = await ensureTokensRefreshed();
  const chainIndexResolved = resolveChain(chain);
  const chainName = await chainNameFor(chainIndexResolved, chain);
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const [, addrInfo] = resolveAddress(wallets, from ?? undefined, chainName);
  const session = store.loadSession();
  if (!session) throw new Error(ERR_NOT_LOGGED_IN);
  const n = parseU64(addrInfo.chainIndex);
  if (n === undefined) throw new Error(`chain id '${addrInfo.chainIndex}' is not a valid number`);
  return { accessToken, addrInfo, chainName, chainIndexResolved, chainIndexNum: n, sessionCert: session.sessionCert };
}

// upstream: gas_station.rs::probe_phase1_diagnostic — zero-amount native self-transfer probe.
export async function probePhase1Diagnostic(client, ctx) {
  const a = ctx.addrInfo;
  try {
    return await client.preTransactionUnsignedInfo(ctx.accessToken, a.chainPath, ctx.chainIndexNum, a.address, a.address, '0', undefined, ctx.sessionCert, '0x',
      undefined, undefined, undefined, undefined, undefined, null, undefined, undefined, undefined);
  } catch (e) {
    throw formatApiError(e);
  }
}

// upstream: gas_station.rs::cmd_status — read-only readiness probe.
export async function cmdStatus(chain, from) {
  const ctx = await buildGsContext(chain, from);
  const probe = await probePhase1Diagnostic(new WalletApiClient(), ctx);
  return {
    chainId: ctx.addrInfo.chainIndex,
    chainName: ctx.chainName,
    fromAddress: ctx.addrInfo.address,
    gasStationActivated: gsStatus(probe) === GasStationStatus.ReadyToUse,
    gasStationDefaultToken: probe.defaultGasTokenAddress === '' ? null : probe.defaultGasTokenAddress,
    gasStationStatus: probe.gasStationStatus,
    recommendation: recommendFromProbe(probe),
    hasPendingTx: probe.hasPendingTx,
    insufficientAll: probe.insufficientAll,
    tokenList: probe.gasStationTokenList.map((t) => ({
      symbol: t.symbol, feeTokenAddress: t.feeTokenAddress, relayerId: t.relayerId, balance: t.balance, serviceCharge: t.serviceCharge, sufficient: t.sufficient,
    })),
  };
}

// upstream: gas_station.rs::recommend_from_probe
export function recommendFromProbe(probe) {
  if (probe.hasPendingTx) return 'HAS_PENDING_TX';
  if (probe.insufficientAll) return 'INSUFFICIENT_ALL';
  switch (gsStatus(probe)) {
    case GasStationStatus.ReadyToUse: case GasStationStatus.NotApplicable: return 'READY';
    case GasStationStatus.FirstTimePrompt: return 'ENABLE_GAS_STATION';
    case GasStationStatus.PendingUpgrade: return 'PENDING_UPGRADE';
    case GasStationStatus.ReenableOnly: return 'REENABLE_GAS_STATION';
    case GasStationStatus.InsufficientAll: return 'INSUFFICIENT_ALL';
    case GasStationStatus.HasPendingTx: return 'HAS_PENDING_TX';
    case GasStationStatus.NotSupportIntention: return 'NOT_SUPPORT_INTENTION';
    default: return probe.gasStationUsed ? 'ENABLE_GAS_STATION' : 'READY';
  }
}

// upstream: gas_station.rs::cmd_setup — idempotent first-time activation (switches the default
// token when already active; otherwise a 1-unit self-transfer through `wallet send`).
export async function cmdSetup(chain, gasTokenAddress, relayerId, from) {
  const ctx = await buildGsContext(chain, from);
  const client = new WalletApiClient();
  const probe = await probePhase1Diagnostic(client, ctx);
  const status = gsStatus(probe);
  if (status === GasStationStatus.ReadyToUse && probe.defaultGasTokenAddress !== '' && eqIgnoreAsciiCase(probe.defaultGasTokenAddress, gasTokenAddress)) {
    return {
      chainId: ctx.addrInfo.chainIndex,
      chainName: ctx.chainName,
      gasStationActivated: true,
      alreadyActivated: true,
      defaultToken: { feeTokenAddress: probe.defaultGasTokenAddress },
      txHash: null,
      needs7702Upgrade: false,
      summary: 'Gas Station already enabled with the requested default token. No action taken.',
    };
  }
  if (status === GasStationStatus.ReadyToUse) {
    try {
      await client.gasStationUpdateDefaultToken(ctx.accessToken, ctx.addrInfo.chainIndex, gasTokenAddress, ctx.addrInfo.address);
    } catch (e) {
      throw formatApiError(e);
    }
    return {
      chainId: ctx.addrInfo.chainIndex,
      chainName: ctx.chainName,
      gasStationActivated: true,
      alreadyActivated: true,
      defaultTokenSwitched: true,
      defaultToken: { feeTokenAddress: gasTokenAddress, relayerId },
      txHash: null,
      needs7702Upgrade: false,
      summary: 'Gas Station was already enabled; only the default gas token was switched (server-side flag flip, no on-chain transaction).',
    };
  }
  if (![GasStationStatus.FirstTimePrompt, GasStationStatus.PendingUpgrade, GasStationStatus.ReenableOnly, GasStationStatus.Unknown].includes(status)) {
    throw new Error(`Cannot setup Gas Station: backend reports state '${probe.gasStationStatus}' which is not first-time-eligible. Run \`wallet gas-station status --chain ${chain}\` for diagnostics.`);
  }
  return cmdSend('1', ctx.addrInfo.address, ctx.chainIndexResolved, from ?? undefined, gasTokenAddress, true, gasTokenAddress, relayerId, true);
}

// upstream: gas_station.rs::attach_success_message
export function attachSuccessMessage(data, message) {
  if (isObject(data)) { data.message = message; return data; }
  return { message, data };
}

// upstream: gas_station.rs::fetch_update_default_token (also used by MCP)
export async function fetchUpdateDefaultToken(chain, gasTokenAddress) {
  const ctx = await buildGsContext(chain, undefined);
  let data;
  try {
    data = await new WalletApiClient().gasStationUpdateDefaultToken(ctx.accessToken, ctx.chainIndexResolved, gasTokenAddress, ctx.addrInfo.address);
  } catch (e) {
    throw formatApiError(e);
  }
  return attachSuccessMessage(data, 'Default Gas token on Solana updated. The chain will pay Gas with the selected stablecoin by default.');
}

// upstream: gas_station.rs::fetch_update — flip the Gas Station DB flag (also used by MCP).
export async function fetchUpdate(chain, enable) {
  const accessToken = await ensureTokensRefreshed();
  const chainIndex = resolveChain(chain);
  const chainName = await chainNameFor(chainIndex, chain);
  const wallets = store.loadWallets();
  if (!wallets) throw new Error(ERR_NOT_LOGGED_IN);
  const [, addrInfo] = resolveAddress(wallets, undefined, chainName);
  let data;
  try { data = await new WalletApiClient().gasStationUpdate(accessToken, chainIndex, enable, addrInfo.address); } catch (e) { throw formatApiError(e); }
  return attachSuccessMessage(data, enable
    ? 'Gas Station is now enabled on Solana. The chain will pay Gas with stablecoins.'
    : 'Gas Station is now disabled on Solana. The chain will pay Gas with SOL; you can re-enable any time.');
}
