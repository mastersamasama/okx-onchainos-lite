// secp256k1 ECDSA: RFC 6979 deterministic nonces, low-s normalisation and a
// recovery id — the same output k256/alloy produce (r || s || v, v ∈ {0,1}).
import { createHmac } from 'node:crypto';
import { keccak256 } from './keccak.mjs';

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];

const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) {
  let [lo, hi, x0, x1] = [mod(a, m), m, 1n, 0n];
  while (lo > 1n) {
    const q = hi / lo;
    [lo, hi] = [hi - q * lo, lo];
    [x0, x1] = [x1 - q * x0, x0];
  }
  return mod(x0, m);
}

// Jacobian coordinates; null = point at infinity.
function jDouble(p) {
  if (!p) return null;
  const [X, Y, Z] = p;
  if (Y === 0n) return null;
  const S = mod(4n * X * Y * Y), M = mod(3n * X * X);
  const X2 = mod(M * M - 2n * S), Y2 = mod(M * (S - X2) - 8n * Y ** 4n), Z2 = mod(2n * Y * Z);
  return [X2, Y2, Z2];
}
function jAdd(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const U1 = mod(X1 * Z2 * Z2), U2 = mod(X2 * Z1 * Z1);
  const S1 = mod(Y1 * Z2 ** 3n), S2 = mod(Y2 * Z1 ** 3n);
  if (U1 === U2) return S1 === S2 ? jDouble(p) : null;
  const H = mod(U2 - U1), R = mod(S2 - S1);
  const H2 = mod(H * H), H3 = mod(H * H2);
  const X3 = mod(R * R - H3 - 2n * U1 * H2);
  return [X3, mod(R * (U1 * H2 - X3) - S1 * H3), mod(H * Z1 * Z2)];
}
function toAffine(p) {
  if (!p) return null;
  const zi = inv(p[2]);
  return [mod(p[0] * zi * zi), mod(p[1] * zi ** 3n)];
}
function mul(k, point = G) {
  let acc = null, add = [point[0], point[1], 1n];
  for (let e = k; e > 0n; e >>= 1n) {
    if (e & 1n) acc = jAdd(acc, add);
    add = jDouble(add);
  }
  return toAffine(acc);
}

const toBig = (buf) => BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
const toBuf32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

function rfc6979(priv, hash) {
  const x = toBuf32(priv), h = toBuf32(mod(toBig(hash), N));
  let V = Buffer.alloc(32, 1), K = Buffer.alloc(32, 0);
  const hmac = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();
  K = hmac(K, V, Buffer.from([0]), x, h); V = hmac(K, V);
  K = hmac(K, V, Buffer.from([1]), x, h); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = toBig(V);
    if (k > 0n && k < N) return k;
    K = hmac(K, V, Buffer.from([0])); V = hmac(K, V);
  }
}

export function publicKey(privKey, compressed = false) {
  const d = toBig(privKey);
  if (d <= 0n || d >= N) throw new Error('invalid secp256k1 private key');
  const [x, y] = mul(d);
  if (compressed) return Buffer.concat([Buffer.from([y & 1n ? 3 : 2]), toBuf32(x)]);
  return Buffer.concat([Buffer.from([4]), toBuf32(x), toBuf32(y)]);
}

export function address(privKey) {
  return '0x' + keccak256(publicKey(privKey).subarray(1)).subarray(12).toString('hex');
}

// Sign a 32-byte prehash. Returns 65 bytes r||s||v with v ∈ {0,1}.
export function sign(privKey, hash32) {
  if (Buffer.from(privKey).length !== 32) throw new Error(`private key must be 32 bytes, got ${Buffer.from(privKey).length}`);
  if (Buffer.from(hash32).length !== 32) throw new Error(`message hash must be 32 bytes, got ${Buffer.from(hash32).length}`);
  const d = toBig(privKey), z = mod(toBig(hash32), N);
  if (d <= 0n || d >= N) throw new Error('invalid secp256k1 private key');
  const k = rfc6979(d, hash32);
  const R = mul(k);
  const r = mod(R[0], N);
  let s = mod(inv(k, N) * (z + r * d), N);
  let v = Number(R[1] & 1n) | (R[0] >= N ? 2 : 0);
  if (s > N / 2n) { s = N - s; v ^= 1; }
  return Buffer.concat([toBuf32(r), toBuf32(s), Buffer.from([v])]);
}

// Recover the uncompressed public key from a 65-byte signature over hash32.
export function recover(hash32, sig) {
  const r = toBig(sig.subarray(0, 32)), s = toBig(sig.subarray(32, 64));
  let v = sig[64];
  if (v >= 27) v -= 27;
  const x = r + (v & 2 ? N : 0n);
  const alpha = mod(x ** 3n + 7n);
  let y = modPow(alpha, (P + 1n) / 4n);
  if ((y & 1n) !== BigInt(v & 1)) y = P - y;
  const e = mod(toBig(hash32), N), ri = inv(r, N);
  const Q = toAffine(jAdd(toJ(mul(mod(-e * ri, N))), toJ(mul(mod(s * ri, N), [x, y]))));
  return Buffer.concat([Buffer.from([4]), toBuf32(Q[0]), toBuf32(Q[1])]);
}
const toJ = (a) => (a ? [a[0], a[1], 1n] : null);
function modPow(b, e, m = P) {
  let r = 1n;
  for (b = mod(b, m); e > 0n; e >>= 1n, b = mod(b * b, m)) if (e & 1n) r = mod(r * b, m);
  return r;
}

export const recoverAddress = (hash32, sig) => '0x' + keccak256(recover(hash32, sig).subarray(1)).subarray(12).toString('hex');
