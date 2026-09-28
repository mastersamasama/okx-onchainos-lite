// EIP-712 typed-data hashing and EIP-191 personal message hashing.
import { keccak256 } from './keccak.mjs';

const hex = (s) => Buffer.from(String(s).replace(/^0x/i, ''), 'hex');
const word = (n) => {
  let v = BigInt(n);
  if (v < 0n) v = (1n << 256n) + v; // two's complement for intN
  return Buffer.from(v.toString(16).padStart(64, '0'), 'hex');
};

const DOMAIN_FIELDS = [
  ['name', 'string'], ['version', 'string'], ['chainId', 'uint256'],
  ['verifyingContract', 'address'], ['salt', 'bytes32'],
];

export function domainType(domain) {
  return DOMAIN_FIELDS.filter(([k]) => domain[k] !== undefined && domain[k] !== null).map(([name, type]) => ({ name, type }));
}

function deps(types, primary, found = new Set()) {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const f of types[primary]) deps(types, f.type.replace(/\[\d*\]$/g, '').replace(/\[\d*\]/g, ''), found);
  return found;
}

export function encodeType(types, primary) {
  const [first, ...rest] = [...deps(types, primary)];
  return [first, ...rest.sort()].map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
}

export const typeHash = (types, primary) => keccak256(encodeType(types, primary));

function encodeValue(types, type, value) {
  if (types[type]) return hashStruct(types, type, value);
  const arr = type.match(/^(.*)\[(\d*)\]$/);
  if (arr) return keccak256(Buffer.concat((value || []).map((v) => encodeValue(types, arr[1], v))));
  if (type === 'string') return keccak256(Buffer.from(String(value), 'utf8'));
  if (type === 'bytes') return keccak256(hex(value));
  if (type === 'bool') return word(value === true || value === 'true' || value === 1 ? 1 : 0);
  if (type === 'address') return Buffer.concat([Buffer.alloc(12), hex(value).subarray(-20)]);
  if (/^bytes\d+$/.test(type)) { const b = Buffer.alloc(32); hex(value).copy(b); return b; }
  if (/^u?int\d*$/.test(type)) return word(value);
  throw new Error(`unsupported EIP-712 type: ${type}`);
}

export function hashStruct(types, primary, data) {
  return keccak256(Buffer.concat([typeHash(types, primary), ...types[primary].map((f) => encodeValue(types, f.type, data[f.name]))]));
}

// typedData: { types (may include EIP712Domain), primaryType, domain, message }
export function signingHash({ types, primaryType, domain, message }) {
  const all = { ...types, EIP712Domain: types.EIP712Domain || domainType(domain) };
  return keccak256(Buffer.concat([
    Buffer.from([0x19, 0x01]),
    hashStruct(all, 'EIP712Domain', domain),
    hashStruct(all, primaryType, message),
  ]));
}

// EIP-191 personal_sign hash of raw bytes.
export function personalHash(data) {
  const b = Buffer.from(data);
  return keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${b.length}`), b]));
}
