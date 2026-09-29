// `payment session open|voucher|topup|close` — the MPP channel-session command bodies of
// upstream commands/payment/dispatcher.rs (cmd_mpp_session_*). The challenge / credential /
// nonce / TEE helpers they share with `payment charge` live in dispatcher.mjs; the per-channel
// deposit + cumulative bookkeeping in session-state.mjs. Every command returns the output data
// object (upstream prints it through `emit_session`).
import { randomBytes } from 'node:crypto';
import { context } from '../core/errors.mjs';
import { trim } from '../core/rs/str.mjs';
import { at, asStr, asU64, asBool } from '../core/rs/value.mjs';
import { intFromStrOk } from '../core/rs/num.mjs';
import {
  parseWwwAuthenticate, decodeChallengeRequest, buildChallengeEcho, base64urlEncodeJson, computeValidBefore,
  computeChannelId, computeOpenNonce, computeTopupNonce, parseSessionSplits, normalizeBytes32Hex, resolveChainAndPayer,
  teeSignEip3009, teeSignVoucher, Eip3009AuthType, emitSession, persistChannelOpen, sessionOpenParams, voucherAdvancesCumulative,
} from './dispatcher.mjs';
import { parseRecipientAddr } from './addr.mjs';
import * as sessionState from './session-state.mjs';

// authorizedSigner = 0x0 sentinel ("payer is the voucher signer"), both in channelId and nonce.
const ZERO_SIGNER = '0x0000000000000000000000000000000000000000';
const U128_MAX = (1n << 128n) - 1n;
const nowSecs = () => BigInt(Math.floor(Date.now() / 1000));
const random32Hex = () => '0x' + randomBytes(32).toString('hex');
// `s.parse::<u128>().unwrap_or(0)`
const u128Or0 = (s) => (s == null ? 0n : intFromStrOk(s, 'u128') ?? 0n);
const didPkh = (chainId, payer) => `did:pkh:eip155:${chainId}:${payer}`;
const isStrictTxHash = (h) => h.startsWith('0x') && Buffer.byteLength(h) === 66 && /^[0-9a-fA-F]*$/.test(h.slice(2));

// upstream: dispatcher.rs::cmd_mpp_session_open — open a payment channel.
// feePayer=true: TEE-sign EIP-3009 deposit + initial voucher (transaction payload);
// feePayer=false: wrap the client-broadcast open tx (requires --tx-hash and --salt).
export async function cmdMppSessionOpen(challengeHeader, deposit, from, txHash, saltArg, initialCumArg, prepayFirst) {
  const challenge = parseWwwAuthenticate(challengeHeader);
  const request = decodeChallengeRequest(challenge);
  const recipientIn = asStr(at(request, 'recipient'));
  if (recipientIn === undefined) throw new Error("missing 'recipient'");
  const currency = asStr(at(request, 'currency'));
  if (currency === undefined) throw new Error("missing 'currency'");
  const md = at(request, 'methodDetails');
  const chainId = asU64(at(md, 'chainId'));
  if (chainId === undefined) throw new Error("missing 'methodDetails.chainId'");
  const escrow = asStr(at(md, 'escrowContract'));
  if (escrow === undefined) throw new Error("missing 'methodDetails.escrowContract'");
  const feePayer = asBool(at(md, 'feePayer')) ?? true;

  let recipient;
  try { [recipient] = parseRecipientAddr(recipientIn, chainId); } catch (e) { throw context('challenge.request.recipient', e); }
  const [chainIndex, payerAddr] = await resolveChainAndPayer(chainId, from);

  let salt;
  if (!feePayer) {
    if (saltArg == null) {
      throw new Error('hash mode (feePayer=false) requires --salt: the same bytes32 you passed to your on-chain `escrow.open(...)` call (0x + 64 hex chars)');
    }
    salt = normalizeBytes32Hex(saltArg, '--salt');
  } else {
    if (saltArg != null) {
      throw new Error('--salt is only valid when challenge.methodDetails.feePayer=false (hash mode); transaction mode generates its own salt during `escrow.openWithAuthorization(...)`. Drop --salt or switch modes.');
    }
    salt = random32Hex();
  }
  if (feePayer && txHash != null) throw new Error('--tx-hash is only valid when challenge.methodDetails.feePayer=false');

  const channelId = computeChannelId(payerAddr, recipient, currency, salt, ZERO_SIGNER, escrow, chainId);
  let initialCum = '0';
  if (initialCumArg != null) initialCum = initialCumArg;
  else if (prepayFirst) {
    const a = asStr(at(request, 'amount'));
    if (a !== undefined && a !== '' && a !== '0') initialCum = a;
  }
  const initialVoucherSig = await teeSignVoucher(chainIndex, payerAddr, channelId, initialCum, escrow, chainId);

  const base = (mode, authorizationHeader) => ({
    protocol: 'mpp', action: 'session_open', mode, authorization_header: authorizationHeader, channel_id: channelId,
    escrow, chain_id: chainId, deposit, wallet: payerAddr,
  });

  if (!feePayer) {
    if (txHash == null) throw new Error('hash mode (feePayer=false) requires --tx-hash (broadcast `escrow.open(...)` yourself first)');
    const hash = normalizeBytes32Hex(txHash, '--tx-hash');
    const credential = {
      challenge: buildChallengeEcho(challenge),
      source: didPkh(chainId, payerAddr),
      payload: { action: 'open', type: 'hash', channelId, salt, hash, cumulativeAmount: initialCum, signature: initialVoucherSig },
    };
    const header = `Payment ${base64urlEncodeJson(credential)}`;
    persistChannelOpen(channelId, payerAddr, deposit, initialCum);
    return emitSession(base('hash', header), sessionOpenParams(channelId, deposit, initialCum));
  }

  const validBefore = computeValidBefore(challenge, nowSecs());
  const [splitRecipients, splitBps] = parseSessionSplits(request, chainId);
  const nonce = computeOpenNonce(payerAddr, recipient, currency, salt, ZERO_SIGNER, splitRecipients, splitBps);
  const [eip3009Signature] = await teeSignEip3009(Eip3009AuthType.Receive, chainIndex, payerAddr, escrow, deposit, validBefore, nonce, currency);
  const credential = {
    challenge: buildChallengeEcho(challenge),
    source: didPkh(chainId, payerAddr),
    payload: {
      action: 'open', type: 'transaction', channelId, salt,
      authorization: { type: 'eip-3009', from: payerAddr, to: escrow, value: deposit, validAfter: '0', validBefore, nonce },
      signature: eip3009Signature, cumulativeAmount: initialCum, voucherSignature: initialVoucherSig,
    },
  };
  const header = `Payment ${base64urlEncodeJson(credential)}`;
  persistChannelOpen(channelId, payerAddr, deposit, initialCum);
  return emitSession(base('transaction', header), sessionOpenParams(channelId, deposit, initialCum));
}

// upstream: dispatcher.rs::cmd_mpp_session_voucher — sign an EIP-712 cumulative voucher via TEE,
// or wrap a previously-signed one (`--reuse-signature`) without touching the TEE.
export async function cmdMppSessionVoucher(challengeHeader, channelId, cumulativeAmount, escrow, chainId, from, reuseSignature) {
  const challenge = parseWwwAuthenticate(challengeHeader);
  let voucherSig, mode;
  if (reuseSignature != null) {
    const normalized = trim(reuseSignature);
    const hexPart = normalized.startsWith('0x') ? normalized.slice(2) : normalized;
    if (Buffer.byteLength(hexPart) !== 130 || !/^[0-9a-fA-F]*$/.test(hexPart)) {
      throw new Error('--reuse-signature must be a 0x-prefixed 65-byte hex string (130 hex chars)');
    }
    voucherSig = normalized.startsWith('0x') ? normalized : `0x${normalized}`;
    mode = 'reuse';
  } else {
    if (escrow == null) throw new Error('--escrow is required when not using --reuse-signature');
    if (chainId == null) throw new Error('--chain-id is required when not using --reuse-signature');
    const [chainIndex, payerAddr] = await resolveChainAndPayer(chainId, from);
    voucherSig = await teeSignVoucher(chainIndex, payerAddr, channelId, cumulativeAmount, escrow, chainId);
    mode = 'sign';
  }
  const credential = {
    challenge: buildChallengeEcho(challenge),
    payload: { action: 'voucher', channelId, cumulativeAmount, signature: voucherSig },
  };
  const header = `Payment ${base64urlEncodeJson(credential)}`;

  // Decision layer: the flag is the ABSOLUTE new cumulative; prior cumulative from persisted
  // state (0 when unknown); unit = new − prior (saturating).
  const prior = sessionState.read(channelId);
  const priorCum = prior ? prior.cumulative : '0';
  const deposit = prior ? prior.deposit : null;
  const newCumU = u128Or0(cumulativeAmount);
  const priorCumU = u128Or0(priorCum);
  const unit = newCumU > priorCumU ? newCumU - priorCumU : 0n;
  const depositU = deposit == null ? null : intFromStrOk(deposit, 'u128') ?? null;
  if (voucherAdvancesCumulative(unit, newCumU, depositU) && prior) {
    prior.cumulative = cumulativeAmount;
    prior.updated_at = sessionState.nowUnix();
    try { prior.write(); } catch {}
  }
  return emitSession(
    { protocol: 'mpp', action: 'voucher', mode, authorization_header: header, channel_id: channelId, signature: voucherSig },
    { action: 'voucher', channel_id: channelId, cumulative_amount: priorCum, unit_amount: unit.toString(), deposit, reuse_signature: reuseSignature ?? null },
  );
}

// upstream: dispatcher.rs::cmd_mpp_session_topup — top up a channel (TEE EIP-3009
// receiveWithAuthorization to the escrow, or hash mode wrapping a client-broadcast tx).
export async function cmdMppSessionTopup(challengeHeader, channelId, additionalDeposit, escrow, chainId, currency, from, txHash) {
  const challenge = parseWwwAuthenticate(challengeHeader);
  const [chainIndex, payerAddr] = await resolveChainAndPayer(chainId, from);
  let payload;
  if (txHash != null) {
    if (!isStrictTxHash(txHash)) throw new Error('--tx-hash must be 0x + 64 hex chars');
    payload = { action: 'topUp', type: 'hash', channelId, hash: txHash, additionalDeposit };
  } else {
    if (currency == null) throw new Error('--currency is required in transaction mode (omit --tx-hash for hash mode)');
    const validBefore = computeValidBefore(challenge, nowSecs());
    const topUpSalt = random32Hex();
    const nonce = computeTopupNonce(payerAddr, channelId, additionalDeposit, topUpSalt);
    const [signature] = await teeSignEip3009(Eip3009AuthType.Receive, chainIndex, payerAddr, escrow, additionalDeposit, validBefore, nonce, currency);
    payload = {
      action: 'topUp', type: 'transaction', channelId, topUpSalt,
      authorization: { type: 'eip-3009', from: payerAddr, to: escrow, value: additionalDeposit, validAfter: '0', validBefore, nonce },
      signature, additionalDeposit,
    };
  }
  const credential = { challenge: buildChallengeEcho(challenge), source: didPkh(chainId, payerAddr), payload };
  const header = `Payment ${base64urlEncodeJson(credential)}`;

  // Grow the persisted deposit so the next voucher's top-up guard / close's refund see it.
  const prior = sessionState.read(channelId);
  const priorCum = prior ? prior.cumulative : '0';
  let newDeposit;
  if (prior) {
    const sum = u128Or0(prior.deposit) + u128Or0(additionalDeposit);
    newDeposit = (sum > U128_MAX ? U128_MAX : sum).toString();
  } else newDeposit = additionalDeposit;
  const now = sessionState.nowUnix();
  try {
    new sessionState.ChannelState({
      channel_id: channelId, owner_wallet: payerAddr, deposit: newDeposit, cumulative: priorCum,
      created_at: prior ? prior.created_at : now, updated_at: now,
    }).write();
  } catch {}
  return emitSession(
    {
      protocol: 'mpp', action: 'session_topup', mode: txHash != null ? 'hash' : 'transaction', authorization_header: header,
      channel_id: channelId, additional_deposit: additionalDeposit, wallet: payerAddr,
    },
    { action: 'topup', channel_id: channelId, cumulative_amount: priorCum, unit_amount: '0', deposit: newDeposit },
  );
}

// upstream: dispatcher.rs::cmd_mpp_session_close — sign the final voucher + close credential;
// the persisted channel state is dropped afterwards.
export async function cmdMppSessionClose(channelId, cumulativeAmount, escrow, chainId, challengeHeader, from) {
  const challenge = parseWwwAuthenticate(challengeHeader);
  const [chainIndex, payerAddr] = await resolveChainAndPayer(chainId, from);
  const signature = await teeSignVoucher(chainIndex, payerAddr, channelId, cumulativeAmount, escrow, chainId);
  const credential = {
    challenge: buildChallengeEcho(challenge),
    payload: { action: 'close', channelId, cumulativeAmount, signature },
  };
  const header = `Payment ${base64urlEncodeJson(credential)}`;
  const prior = sessionState.read(channelId);
  const priorCum = prior ? prior.cumulative : '0';
  const deposit = prior ? prior.deposit : null;
  const finalU = u128Or0(cumulativeAmount);
  const priorU = u128Or0(priorCum);
  const unit = finalU > priorU ? finalU - priorU : 0n;
  const out = await emitSession(
    { protocol: 'mpp', action: 'session_close', authorization_header: header, channel_id: channelId },
    { action: 'close', channel_id: channelId, cumulative_amount: priorCum, unit_amount: unit.toString(), deposit },
  );
  sessionState.cleanup(channelId);
  return out;
}
