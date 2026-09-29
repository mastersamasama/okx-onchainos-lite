// Byte-encoding crates with their exact error texts: base64 0.22, hex 0.4, bs58 0.5 (Bitcoin
// alphabet), and `hex::encode(Sha256::digest(..))`. Node's built-ins are lenient where these crates
// are strict (e.g. Buffer.from(s, 'base64') accepts "not-base64"), which changes upstream's error
// branches.
import { createHash } from 'node:crypto';
import { base58Encode } from '../../crypto/encoding.mjs';
import { charDebug } from './str.mjs';

// ── base64 0.22 GeneralPurpose engines (decode_allow_trailing_bits = false) ──

const table = (alphabet) => { const t = new Int16Array(256).fill(-1); for (let i = 0; i < 64; i++) t[alphabet.charCodeAt(i)] = i; return t; };
const STD_TABLE = table('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const URL_TABLE = table('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');
const PAD = 0x3d;

// Engine::decode → Buffer; throws the DecodeError Display text. `canonical` padding (STANDARD /
// URL_SAFE) requires `=` to a multiple of 4; the *_NO_PAD engines reject any `=`.
function decode(input, t, canonical) {
  const inp = Buffer.from(String(input), 'utf8');
  const rem = inp.length % 4;
  if (rem === 1) {
    const last = inp[inp.length - 1];
    if (last !== PAD && t[last] < 0) throw new Error(`Invalid symbol ${last}, offset ${inp.length - 1}.`);
  }
  const quads = Math.max(0, inp.length - rem - (rem === 0 ? 4 : 0));
  const out = [];
  for (let i = 0; i < quads; i += 4) {
    let acc = 0;
    for (let j = 0; j < 4; j++) {
      const m = t[inp[i + j]];
      if (m < 0) throw new Error(`Invalid symbol ${inp[i + j]}, offset ${i + j}.`);
      acc = (acc << 6) | m;
    }
    out.push((acc >> 16) & 255, (acc >> 8) & 255, acc & 255);
  }
  // decode_suffix
  let morsels = 0, pads = 0, firstPad = 0, last = 0;
  const ms = [0, 0, 0, 0];
  for (let k = quads; k < inp.length; k++) {
    const b = inp[k], li = k - quads;
    if (b === PAD) {
      if (li < 2) throw new Error(`Invalid symbol ${b}, offset ${k}.`);
      if (pads === 0) firstPad = li;
      pads++;
      continue;
    }
    if (pads > 0) throw new Error(`Invalid symbol ${PAD}, offset ${quads + firstPad}.`);
    last = b;
    const m = t[b];
    if (m < 0) throw new Error(`Invalid symbol ${b}, offset ${k}.`);
    ms[morsels++] = m;
  }
  if (inp.length && morsels < 2) throw new Error(`Invalid input length: ${quads + morsels}`);
  if (canonical ? (pads + morsels) % 4 !== 0 : pads > 0) throw new Error('Invalid padding');
  const nbytes = Math.floor((morsels * 6) / 8);
  let n = ((ms[0] << 26) | (ms[1] << 20) | (ms[2] << 14) | (ms[3] << 8)) >>> 0;
  const mask = nbytes === 0 ? 0xffffffff : (0xffffffff >>> (nbytes * 8)) >>> 0;
  if (((n & mask) >>> 0) !== 0) throw new Error(`Invalid last symbol ${last}, offset ${quads + morsels - 1}.`);
  for (let k = 0; k < nbytes; k++) { out.push((n >>> 24) & 255); n = (n << 8) >>> 0; }
  return Buffer.from(out);
}
const engine = (urlSafe, canonical) => Object.freeze({
  decode: (input) => decode(input, urlSafe ? URL_TABLE : STD_TABLE, canonical),
  encode: (bytes) => {
    const s = Buffer.from(bytes).toString('base64');
    const t = urlSafe ? s.replace(/\+/g, '-').replace(/\//g, '_') : s;
    return canonical ? t : t.replace(/=+$/, '');
  },
});
// base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD}
export const B64 = Object.freeze({
  STANDARD: engine(false, true),
  STANDARD_NO_PAD: engine(false, false),
  URL_SAFE: engine(true, true),
  URL_SAFE_NO_PAD: engine(true, false),
});

// ── hex 0.4 ─────────────────────────────────────────────────────────

const hexValue = (b) => (b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x57 : b >= 0x41 && b <= 0x46 ? b - 0x37 : -1);
// hex::decode → Buffer; throws the FromHexError Display text.
export function hexDecode(s) {
  const b = Buffer.from(String(s), 'utf8');
  if (b.length % 2 !== 0) throw new Error('Odd number of digits');
  const out = Buffer.alloc(b.length / 2);
  for (let i = 0; i < b.length; i += 2) {
    const hi = hexValue(b[i]);
    if (hi < 0) throw new Error(`Invalid character ${charDebug(String.fromCharCode(b[i]))} at position ${i}`);
    const lo = hexValue(b[i + 1]);
    if (lo < 0) throw new Error(`Invalid character ${charDebug(String.fromCharCode(b[i + 1]))} at position ${i + 1}`);
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}
// hex::encode (lowercase)
export const hexEncode = (bytes) => Buffer.from(bytes).toString('hex');
// hex::encode(Sha256::digest(data)) — a string hashes as its UTF-8 bytes
export const sha256Hex = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');

// ── bs58 0.5 (Bitcoin alphabet) ─────────────────────────────────────

const B58_TABLE = new Int16Array(128).fill(-1);
for (const [i, c] of [...'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'].entries()) B58_TABLE[c.charCodeAt(0)] = i;
// bs58::decode(s).into_vec() → Buffer; throws the bs58::decode::Error Display text.
export function bs58Decode(s) {
  const input = Buffer.from(String(s), 'utf8');
  let n = 0n;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c > 127) throw new Error(`provided string contained non-ascii character starting at byte ${i}`);
    const v = B58_TABLE[c];
    if (v < 0) throw new Error(`provided string contained invalid character ${charDebug(String.fromCharCode(c))} at byte ${i}`);
    n = n * 58n + BigInt(v);
  }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0x31) zeros++;
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}
// bs58::encode(bytes).into_string()
export const bs58Encode = (bytes) => base58Encode(Buffer.from(bytes));
