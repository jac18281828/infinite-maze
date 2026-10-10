// Seed codes, the world key, the tagged hash H and sfc32.
import { sha3_256 } from './keccak.mjs';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Canonical 8-character seed code from user text, or null. Accepts
 * lower case, an optional hyphen and Crockford's aliases (I, L -> 1; O -> 0).
 */
export function parseCode(text) {
  const t = String(text).toUpperCase().replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0');
  if (t.length !== 8) return null;
  for (const ch of t) if (!CROCKFORD.includes(ch)) return null;
  return t;
}

/** `K7Q2M9XA` -> `K7Q2-M9XA`. */
export function formatCode(code) {
  return code.slice(0, 4) + '-' + code.slice(4);
}

/** Eight Crockford characters from five random bytes (40 bits). */
export function codeFromBytes(bytes) {
  let v = 0n;
  for (let i = 0; i < 5; i++) v = (v << 8n) | BigInt(bytes[i]);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((v >> BigInt(5 * i)) & 31n)];
  return out;
}

function ascii(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/** WORLD = SHA3-256("infinite-maze/v1" ‖ code), code as 8 ASCII characters. */
export function worldKey(code) {
  return sha3_256(ascii('infinite-maze/v1' + code));
}

/**
 * Returns H(tag, n1, n2, ...) = SHA3-256(WORLD ‖ tag ‖ int64be(n1) ‖ ...).
 * Integers must be safe integers; negatives encode as two's complement.
 */
export function makeHasher(world) {
  const buf = new Uint8Array(32 + 16 + 8 * 4);
  buf.set(world, 0);
  return function H(tag, ...ns) {
    let o = 32;
    for (let i = 0; i < tag.length; i++) buf[o++] = tag.charCodeAt(i);
    for (const n of ns) {
      writeInt64BE(buf, o, n);
      o += 8;
    }
    return sha3_256(buf.subarray(0, o));
  };
}

/** Writes safe integer n at b[o..o+7] as big-endian two's complement. */
export function writeInt64BE(b, o, n) {
  const hi = Math.floor(n / 4294967296);
  writeU32(b, o, hi >>> 0);
  writeU32(b, o + 4, (n - hi * 4294967296) >>> 0);
}

function writeU32(b, o, v) {
  b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
}

/** Big-endian u32 at byte offset `o` of a digest. */
export function u32(d, o = 0) {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

/** sfc32 seeded with the first 16 bytes of a digest; yields u32 values. */
export function sfc32(d) {
  let a = u32(d, 0) | 0, b = u32(d, 4) | 0, c = u32(d, 8) | 0, n = u32(d, 12) | 0;
  return function next() {
    const t = (((a + b) | 0) + n) | 0;
    n = (n + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
