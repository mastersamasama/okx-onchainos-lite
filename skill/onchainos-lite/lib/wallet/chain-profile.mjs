// Chain capability routing — upstream agentic_wallet/chain_profile.rs.
import { getChainByRealChainIndex, getAllChains } from './chain.mjs';
import { rustTrim, asciiLower, eqIgnoreAsciiCase, isI64, getField as get } from './_rs.mjs';

// upstream: chain_profile.rs::TransferDriver / InscriptionDriver / MessageSignDriver
export const TransferDriver = Object.freeze({ LegacyAccount: 'LegacyAccount', Bitcoin: 'Bitcoin', Sui: 'Sui', Unsupported: 'Unsupported' });
export const InscriptionDriver = Object.freeze({ Bitcoin: 'Bitcoin', Unsupported: 'Unsupported' });
export const MessageSignDriver = Object.freeze({ LegacyAccount: 'LegacyAccount', Unsupported: 'Unsupported' });

// upstream: chain_profile.rs::ResolvedChainProfile
export class ResolvedChainProfile {
  constructor({ chainIndex, realChainIndex, chainName, nativeSymbol, nativeDecimals, capabilities }) {
    Object.assign(this, { chainIndex, realChainIndex, chainName, nativeSymbol, nativeDecimals, capabilities });
  }
  // upstream: chain_profile.rs::ResolvedChainProfile::is_bitcoin
  isBitcoin() { return this.capabilities.transfer === TransferDriver.Bitcoin; }
}


// upstream: chain_profile.rs::resolve
export async function resolve(input) {
  let entry = await getChainByRealChainIndex(input);
  if (!entry) {
    entry = (await getAllChains()).find((e) => entryMatchesNameOrAlias(e, input));
    if (!entry) throw new Error(`unsupported chain: ${input}`);
  }
  return fromEntry(entry);
}

// upstream: chain_profile.rs::entry_matches_name_or_alias
export function entryMatchesNameOrAlias(entry, input) {
  const needle = rustTrim(input);
  const name = get(entry, 'chainName');
  const aliases = get(entry, 'alias');
  const direct = stringField(entry, 'chainIndex') === needle
    || (typeof name === 'string' && eqIgnoreAsciiCase(name, needle))
    || (Array.isArray(aliases) && aliases.some((a) => typeof a === 'string' && eqIgnoreAsciiCase(a, needle)));
  if (direct) return true;
  return ['bitcoin', 'btc'].includes(asciiLower(needle)) && typeof name === 'string' && ['bitcoin', 'btc'].includes(asciiLower(name));
}

// upstream: chain_profile.rs::string_field — string, or i64 rendered; else undefined.
export function stringField(entry, key) {
  const v = get(entry, key);
  if (typeof v === 'string') return v;
  if (isI64(v)) return String(v);
  return undefined;
}

// upstream: chain_profile.rs::from_entry
export function fromEntry(entry) {
  const chainIndex = stringField(entry, 'chainIndex');
  if (chainIndex === undefined) throw new Error('chain profile: chain entry missing chainIndex');
  const realChainIndex = stringField(entry, 'realChainIndex');
  if (realChainIndex === undefined) throw new Error('chain profile: chain entry missing realChainIndex');
  const chainName = stringField(entry, 'chainName');
  if (chainName === undefined) throw new Error('chain profile: chain entry missing chainName');
  const [nativeSymbol, nativeDecimals, capabilities] = overlay(entry);
  if (rustTrim(chainIndex) === '' || rustTrim(realChainIndex) === '') throw new Error('chain profile: chain identifiers must not be empty');
  return new ResolvedChainProfile({ chainIndex, realChainIndex, chainName, nativeSymbol, nativeDecimals, capabilities });
}

const caps = (transfer, inscription, contractCall, messageSign) => Object.freeze({ transfer, inscription, contractCall, messageSign });

// upstream: chain_profile.rs::overlay → [nativeSymbol, nativeDecimals, capabilities]
export function overlay(entry) {
  let serverSymbol;
  for (const k of ['nativeSymbol', 'chainSymbol', 'symbol']) {
    const v = get(entry, k);
    if (typeof v === 'string') { serverSymbol = v; break; }
  }
  if (serverSymbol === '') serverSymbol = undefined;
  const m = (x) => entryMatchesNameOrAlias(entry, x);
  if (m('bitcoin') || m('btc')) return [serverSymbol ?? 'BTC', 8, caps(TransferDriver.Bitcoin, InscriptionDriver.Bitcoin, false, MessageSignDriver.Unsupported)];
  if (m('sui')) return [serverSymbol ?? 'SUI', 9, caps(TransferDriver.Sui, InscriptionDriver.Unsupported, true, MessageSignDriver.Unsupported)];
  if (get(entry, 'isEvmChain') === true || m('solana') || m('sol') || m('tron') || m('trx') || m('ton')) return legacyOverlay(serverSymbol ?? '', 18);
  return [serverSymbol ?? '', 0, caps(TransferDriver.Unsupported, InscriptionDriver.Unsupported, false, MessageSignDriver.Unsupported)];
}

// upstream: chain_profile.rs::legacy_overlay
export const legacyOverlay = (symbol, decimals) => [symbol, decimals, caps(TransferDriver.LegacyAccount, InscriptionDriver.Unsupported, true, MessageSignDriver.LegacyAccount)];
