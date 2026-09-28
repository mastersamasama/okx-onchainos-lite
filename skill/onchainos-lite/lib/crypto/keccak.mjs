// Keccak-256 (Ethereum flavour: pad 0x01, not SHA3's 0x06). Constants are derived
// from the FIPS 202 definitions at load time instead of being hand-copied tables.
const MASK = (1n << 64n) - 1n;

function rcBit(t) {
  if (t % 255 === 0) return 1;
  let r = 1;
  for (let i = 1; i <= t % 255; i++) {
    r <<= 1;
    if (r & 0x100) r ^= 0x171;
  }
  return r & 1;
}

const RC = Array.from({ length: 24 }, (_, ir) => {
  let c = 0n;
  for (let j = 0; j <= 6; j++) if (rcBit(j + 7 * ir)) c |= 1n << BigInt((1 << j) - 1);
  return c;
});

const ROT = new Array(25).fill(0n);
for (let t = 0, x = 1, y = 0; t < 24; t++) {
  ROT[x + 5 * y] = BigInt(((t + 1) * (t + 2) / 2) % 64);
  [x, y] = [y, (2 * x + 3 * y) % 5];
}

const rotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK);

function keccakF(A) {
  const C = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let y = 0; y < 25; y += 5)
      for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK & B[((x + 2) % 5) + y]);
    A[0] ^= RC[round];
  }
}

export function keccak256(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const rate = 136;
  const padded = Buffer.alloc(Math.floor(bytes.length / rate) * rate + rate);
  bytes.copy(padded);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8);
  return out;
}
