// PRIVATE — rust-bitcoin 0.32 `Address<NetworkUnchecked>::from_str`, `require_network`,
// `address_type` and `script_pubkey`, with the crate's (std-build) error Display texts, which
// upstream embeds in `invalid <field> Bitcoin address: <e>` / `<field> must be a Bitcoin mainnet
// address: <e>`. Segwit strings are decoded per bech32 0.11 (BIP-173/350); a failed segwit decode
// falls back to the legacy base58check path exactly as the crate does.
import { createHash } from 'node:crypto';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const FE = new Map([...CHARSET].map((c, i) => [c, i]));
const BECH32_CONST = 1, BECH32M_CONST = 0x2bc830a3;
const MAX_STRING_LENGTH = 90;

function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}

// bech32::segwit::decode → { hrp, version, program } | null (any failure → null)
export function segwitDecode(s) {
  if (Buffer.byteLength(s, 'utf8') > MAX_STRING_LENGTH) return null;
  // check_characters (scan from the end; data part must be bech32 chars; no mixed case)
  const chars = [...s];
  let sepPos = -1, hasUpper = false, hasLower = false;
  for (let n = chars.length - 1; n >= 0; n--) {
    const ch = chars[n];
    if (ch === '1' && sepPos < 0) sepPos = n;
    if (sepPos < 0 && (ch.length !== 1 || ch.charCodeAt(0) > 127 || !FE.has(ch.toLowerCase()))) return null;
    if (/[A-Z]/.test(ch)) hasUpper = true;
    else if (/[a-z]/.test(ch)) hasLower = true;
  }
  if ((hasUpper && hasLower) || sepPos < 0) return null;
  const hrp = chars.slice(0, sepPos).join('');
  // Hrp::parse: 1..=83 ASCII chars in 33..=126
  if (hrp.length < 1 || hrp.length > 83) return null;
  for (const c of hrp) { const cp = c.codePointAt(0); if (cp < 33 || cp > 126) return null; }
  const data = chars.slice(sepPos + 1).map((c) => FE.get(c.toLowerCase()));
  if (!data.length) return null;
  const version = data[0];
  if (version > 16) return null;
  if (data.length < 6) return null;
  const lower = hrp.toLowerCase();
  const expand = [...lower].map((c) => c.charCodeAt(0) >> 5).concat([0], [...lower].map((c) => c.charCodeAt(0) & 31));
  const residue = polymod([...expand, ...data]);
  if (residue !== (version === 0 ? BECH32_CONST : BECH32M_CONST)) return null;
  const payload = data.slice(1, data.length - 6);
  // validate_segwit_padding + fes → bytes
  const padBits = (payload.length * 5) % 8;
  if (padBits > 4) return null;
  if (payload.length && (payload[payload.length - 1] & ((1 << padBits) - 1)) !== 0) return null;
  const bytes = [];
  let acc = 0, bits = 0;
  for (const v of payload) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  // validate_witness_program_length
  if (bytes.length < 2 || bytes.length > 40) return null;
  if (version === 0 && bytes.length !== 20 && bytes.length !== 32) return null;
  return { hrp, version, program: Buffer.from(bytes) };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256d = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();

// base58ck::decode_check → Buffer | null
function base58CheckDecode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const raw = Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
  if (raw.length < 4) return null;
  const data = raw.subarray(0, raw.length - 4);
  if (!sha256d(data).subarray(0, 4).equals(raw.subarray(raw.length - 4))) return null;
  return data;
}

// Address::<NetworkUnchecked>::from_str → { kind, network, version?, program?, hash? }
export function parseUnchecked(s) {
  const seg = segwitDecode(s);
  if (seg) {
    const hrp = seg.hrp.toLowerCase();
    const network = hrp === 'bc' ? 'main' : hrp === 'tb' ? 'test' : hrp === 'bcrt' ? 'regtest' : null;
    if (!network) throw new Error('tried to parse an unknown hrp');
    return { kind: 'segwit', network, version: seg.version, program: seg.program };
  }
  if (Buffer.byteLength(s, 'utf8') > 50) throw new Error('legacy address base58 string');
  const data = base58CheckDecode(s);
  if (!data) throw new Error('base58 error');
  if (data.length !== 21) throw new Error('legacy address base58 data');
  const hash = data.subarray(1);
  switch (data[0]) {
    case 0: return { kind: 'p2pkh', network: 'main', hash };
    case 111: return { kind: 'p2pkh', network: 'test', hash };
    case 5: return { kind: 'p2sh', network: 'main', hash };
    case 196: return { kind: 'p2sh', network: 'test', hash };
    default: throw new Error('legacy address base58 prefix');
  }
}

// Address::require_network(Network::Bitcoin)
export function requireMainnet(addr) {
  if (addr.network !== 'main') throw new Error('validation error');
  return addr;
}

// Address::address_type → 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'p2a' | null
export function addressType(addr) {
  if (addr.kind !== 'segwit') return addr.kind;
  const len = addr.program.length;
  if (addr.version === 0) return len === 20 ? 'p2wpkh' : len === 32 ? 'p2wsh' : null;
  if (addr.version === 1 && len === 32) return 'p2tr';
  if (addr.version === 1 && len === 2 && addr.program[0] === 0x4e && addr.program[1] === 0x73) return 'p2a';
  return null;
}

// Address::script_pubkey → Buffer
export function scriptPubkey(addr) {
  if (addr.kind === 'p2pkh') return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), addr.hash, Buffer.from([0x88, 0xac])]);
  if (addr.kind === 'p2sh') return Buffer.concat([Buffer.from([0xa9, 0x14]), addr.hash, Buffer.from([0x87])]);
  return Buffer.concat([Buffer.from([addr.version === 0 ? 0 : 0x50 + addr.version, addr.program.length]), addr.program]);
}
