// Byte encodings shared by signing flows: hex, base58, EIP-55 checksum addresses.
import { keccak256 } from './keccak.mjs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(buf) {
  const b = Buffer.from(buf);
  let n = BigInt('0x' + (b.toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (let i = 0; i < b.length && b[i] === 0; i++) out = '1' + out;
  return out;
}

export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character '${c}'`);
    n = n * 58n + BigInt(i);
  }
  let h = n === 0n ? '' : n.toString(16);
  if (h.length % 2) h = '0' + h;
  const zeros = str.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(h, 'hex')]);
}

export const stripHex = (s) => String(s).replace(/^0x/i, '');
export const fromHex = (s) => Buffer.from(stripHex(s), 'hex');
export const toHex = (b) => '0x' + Buffer.from(b).toString('hex');

export function checksumAddress(addr) {
  const a = stripHex(addr).toLowerCase();
  const h = keccak256(a).toString('hex');
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

// Decode a message given upstream's encoding names ("hex" | "base64" | "base58" | "utf8").
export function decodeMessage(msg, encoding) {
  switch (encoding) {
    case 'hex': return fromHex(msg);
    case 'base64': return Buffer.from(msg, 'base64');
    case 'base58': return base58Decode(msg);
    case 'utf8': return Buffer.from(msg, 'utf8');
    default: throw new Error(`unsupported encoding: ${encoding}, expected hex/base64/base58`);
  }
}
