// wallet send | contract-call
// upstream: commands/agentic_wallet/mod.rs::execute (Send / ContractCall arms, resolve_send_amount)
//   → transfer/{mod,bitcoin,sui}.rs
import { resolveChain } from '../../core/chains.mjs';
import { F64 } from '../../core/json.mjs';
import { resolveAndValidate } from '../../core/token-alias.mjs';
import { readableToMinimalStr } from '../../core/validators.mjs';
import { WalletApiClient, displayTop } from '../../wallet/api.mjs';
import { ensureTokensRefreshed } from '../../wallet/auth.mjs';
import { resolve as resolveChainProfile, TransferDriver } from '../../wallet/chain-profile.mjs';
import { cmdSendWithReadable, cmdContractCall } from '../../wallet/transfer/index.mjs';
import * as bitcoin from '../../wallet/transfer/bitcoin.mjs';
import * as sui from '../../wallet/transfer/sui.mjs';
import { get, asU64 } from '../../core/rs/value.mjs';
import { trim } from '../../core/rs/str.mjs';
import { parseU32, parseU64, toU32 } from '../../core/rs/num.mjs';

const some = (v) => v !== undefined && v !== null;

// upstream: agentic_wallet/mod.rs::resolve_send_amount → minimal-unit amount string
export async function resolveSendAmount(amt, readableAmount, contractToken, chain) {
  if (some(amt)) {
    const raw = trim(amt);
    if (raw === '') throw new Error('--amt must not be empty');
    if (raw.includes('.')) throw new Error('--amt must be a whole number in minimal units (no decimals)');
    if (!/^[0-9]*$/.test(raw)) throw new Error(`--amt must be a whole number in minimal units, got "${raw}"`);
    if (/^0*$/.test(raw)) throw new Error('--amt must be greater than zero');
    if (raw.startsWith('0')) throw new Error(`--amt must not have leading zeros, got "${raw}"`);
    return raw;
  }
  if (some(readableAmount)) {
    const readable = trim(readableAmount);
    if (readable === '') throw new Error('--readable-amount must not be empty');
    let decimal;
    if (!some(contractToken)) {
      decimal = chain === '501' || chain === '784' ? 9 : 18;
    } else {
      const accessToken = await ensureTokensRefreshed();
      const client = new WalletApiClient();
      const chainIndexStr = resolveChain(chain);
      const chainIndexNum = parseU64(chainIndexStr);
      if (chainIndexNum === undefined) throw new Error(`chain id '${chainIndexStr}' is not a valid number for token-info lookup`);
      let info;
      try {
        info = await client.getTokenInfo(accessToken, chainIndexNum, contractToken);
      } catch (e) {
        throw new Error(`Failed to fetch token decimals for ${contractToken}: ${displayTop(e)}. Use --amt with raw minimal units instead.`);
      }
      const entry = Array.isArray(info) && info.length ? info[0] : info;
      const decimals = get(entry, 'decimals');
      const value = decimals !== undefined && decimals !== null ? decimals : get(entry, 'decimal');
      if (typeof value === 'string') {
        decimal = parseU32(value);
        if (decimal === undefined) throw new Error(`Invalid decimal value "${value}" for token ${contractToken}`);
      } else if (typeof value === 'number' || typeof value === 'bigint' || value instanceof F64) {
        const n = asU64(value);
        if (n === undefined) throw new Error(`Invalid decimal value for token ${contractToken}`);
        decimal = toU32(n);
      } else {
        throw new Error(`Token decimal not found for ${contractToken}. Use --amt with raw minimal units instead.`);
      }
    }
    return readableToMinimalStr(readable, decimal);
  }
  throw new Error('Either --amt or --readable-amount is required');
}

// upstream: mod.rs::execute — WalletCommand::Send arm
async function walletSend(o, brc20Outpoints) {
  const profile = await resolveChainProfile(o.chain);
  const gs = some(o.gasTokenAddress) || some(o.relayerId) || o.enableGasStation;
  if (profile.capabilities.transfer === TransferDriver.Bitcoin) {
    if (some(o.amt)) throw new Error('Bitcoin transfers require --readable-amount');
    if (gs) throw new Error('Gas Station is not supported for Bitcoin transfers');
    return bitcoin.cmdSend(o.readableAmount, o.recipient, o.from, o.contractToken, brc20Outpoints, o.feeRate, o.force);
  }
  if (profile.capabilities.transfer === TransferDriver.Sui) {
    if (brc20Outpoints.length) throw new Error('--brc20-outpoint is only supported for Bitcoin BRC-20 transfers');
    if (some(o.amt)) throw new Error('SUI transfers require --readable-amount');
    if (gs) throw new Error('Gas Station is not supported for SUI transfers');
    if (some(o.feeRate)) throw new Error('--fee-rate is only supported for Bitcoin transfers');
    if (!some(o.readableAmount)) throw new Error('--readable-amount is required');
    return sui.cmdSend(o.readableAmount, o.recipient, o.from, o.contractToken, o.force);
  }
  if (brc20Outpoints.length) throw new Error('--brc20-outpoint is only supported for Bitcoin BRC-20 transfers');
  if (some(o.feeRate)) throw new Error('--fee-rate is only supported for Bitcoin transfers');
  const chain = resolveChain(o.chain);
  const contractToken = some(o.contractToken) ? resolveAndValidate(chain, o.contractToken, 'contract-token') : undefined;
  const rawAmt = await resolveSendAmount(o.amt, o.readableAmount, contractToken, chain);
  return cmdSendWithReadable(rawAmt, o.readableAmount, o.recipient, chain, o.from, contractToken, o.force, o.gasTokenAddress, o.relayerId, o.enableGasStation);
}

// upstream: mod.rs::execute — WalletCommand::ContractCall arm
async function walletContractCall(o) {
  const profile = await resolveChainProfile(o.chain);
  if (!profile.capabilities.contractCall) throw new Error(`wallet contract-call is not supported for chain '${profile.chainName}'`);
  if (profile.capabilities.transfer === TransferDriver.Sui) {
    if (some(o.inputData) || some(o.unsignedTx)) throw new Error('SUI contract calls require --sui-tx-bytes, not --input-data or --unsigned-tx');
    if (!some(o.suiTxBytes)) throw new Error('--sui-tx-bytes is required for SUI contract calls');
    if (some(o.gasLimit) || some(o.aaDexTokenAddr) || some(o.aaDexTokenAmount) || o.mevProtection || some(o.jitoUnsignedTx)
      || some(o.gasTokenAddress) || some(o.relayerId) || o.enableGasStation) {
      throw new Error('EVM/Solana-only contract-call options are not supported with --sui-tx-bytes');
    }
    return sui.cmdContractCall(o.suiTxBytes, o.to, o.amt, o.from, o.force, o.bizType, o.strategy);
  }
  if (some(o.suiTxBytes)) throw new Error('--sui-tx-bytes is only supported for SUI contract calls');
  if (!some(o.to)) throw new Error('--to is required for EVM and Solana contract calls');
  return cmdContractCall(o.to, o.chain, o.amt, o.inputData, o.unsignedTx, o.gasLimit, o.from, o.aaDexTokenAddr, o.aaDexTokenAmount,
    o.mevProtection, o.jitoUnsignedTx, o.force, o.gasTokenAddress, o.relayerId, o.enableGasStation, o.bizType, o.strategy);
}

export default {
  'wallet send': {
    uses: ['amt', 'readableAmount', 'recipient', 'chain', 'from', 'contractToken', 'brc20Outpoint', 'feeRate', 'force', 'gasTokenAddress', 'relayerId', 'enableGasStation'],
    run: (ctx, o) => walletSend(o, o.brc20Outpoint ?? []),
  },

  'wallet contract-call': {
    uses: ['to', 'chain', 'amt', 'inputData', 'unsignedTx', 'suiTxBytes', 'gasLimit', 'from', 'aaDexTokenAddr', 'aaDexTokenAmount', 'mevProtection',
      'jitoUnsignedTx', 'force', 'gasTokenAddress', 'relayerId', 'enableGasStation', 'bizType', 'strategy'],
    run: (ctx, o) => walletContractCall(o),
  },
};
