// SHA3-256 (FIPS 202) over Keccak-f[1600]. Lanes are held as 32-bit halves:
// lane i occupies s[2i] (low word) and s[2i + 1] (high word).

const RC = [
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000,
  0x80008000, 0x80000000, 0x0000808b, 0x00000000, 0x80000001, 0x00000000,
  0x80008081, 0x80000000, 0x00008009, 0x80000000, 0x0000008a, 0x00000000,
  0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000,
  0x00008003, 0x80000000, 0x00008002, 0x80000000, 0x00000080, 0x80000000,
  0x0000800a, 0x00000000, 0x8000000a, 0x80000000, 0x80008081, 0x80000000,
  0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
];

// Rotation offset for lane x + 5y.
const RHO = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
  41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

// Destination lane of lane x + 5y under pi: (y, 2x + 3y).
const PI = new Int32Array(25);
for (let x = 0; x < 5; x++) {
  for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);
}

const B = new Int32Array(50);
const C = new Int32Array(10);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      const i = 2 * x;
      C[i] = s[i] ^ s[i + 10] ^ s[i + 20] ^ s[i + 30] ^ s[i + 40];
      C[i + 1] = s[i + 1] ^ s[i + 11] ^ s[i + 21] ^ s[i + 31] ^ s[i + 41];
    }
    for (let x = 0; x < 5; x++) {
      const p = 2 * ((x + 4) % 5);
      const n = 2 * ((x + 1) % 5);
      const lo = C[n], hi = C[n + 1];
      const dl = C[p] ^ ((lo << 1) | (hi >>> 31));
      const dh = C[p + 1] ^ ((hi << 1) | (lo >>> 31));
      for (let y = 0; y < 50; y += 10) {
        s[2 * x + y] ^= dl;
        s[2 * x + y + 1] ^= dh;
      }
    }
    // rho and pi
    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i], hi = s[2 * i + 1];
      const r = RHO[i];
      const d = 2 * PI[i];
      if (r === 0) {
        B[d] = lo; B[d + 1] = hi;
      } else if (r < 32) {
        B[d] = (lo << r) | (hi >>> (32 - r));
        B[d + 1] = (hi << r) | (lo >>> (32 - r));
      } else if (r === 32) {
        B[d] = hi; B[d + 1] = lo;
      } else {
        const m = r - 32;
        B[d] = (hi << m) | (lo >>> (32 - m));
        B[d + 1] = (lo << m) | (hi >>> (32 - m));
      }
    }
    // chi
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 5; x++) {
        const a = y + 2 * x;
        const b = y + 2 * ((x + 1) % 5);
        const c = y + 2 * ((x + 2) % 5);
        s[a] = B[a] ^ (~B[b] & B[c]);
        s[a + 1] = B[a + 1] ^ (~B[b + 1] & B[c + 1]);
      }
    }
    // iota
    s[0] ^= RC[2 * round];
    s[1] ^= RC[2 * round + 1];
  }
}

const RATE = 136;

/** SHA3-256 of `bytes`. */
export function sha3_256(bytes) {
  const s = new Int32Array(50);
  const len = bytes.length;
  let off = 0;
  // Absorb full blocks; the final padded block is always absorbed below.
  while (len - off >= RATE) {
    for (let j = 0; j < RATE; j++) {
      s[j >> 2] ^= bytes[off + j] << ((j & 3) << 3);
    }
    keccakF(s);
    off += RATE;
  }
  const rest = len - off;
  for (let j = 0; j < rest; j++) {
    s[j >> 2] ^= bytes[off + j] << ((j & 3) << 3);
  }
  s[rest >> 2] ^= 0x06 << ((rest & 3) << 3);
  s[(RATE - 1) >> 2] ^= 0x80 << (((RATE - 1) & 3) << 3);
  keccakF(s);
  const out = new Uint8Array(32);
  for (let j = 0; j < 32; j++) out[j] = (s[j >> 2] >>> ((j & 3) << 3)) & 0xff;
  return out;
}
