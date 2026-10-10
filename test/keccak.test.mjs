import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha3_256 } from '../src/world/keccak.mjs';
import { toHex } from '../src/world/hash.mjs';
import { checkKeccak } from '../tools/acceptance.mjs';

const hex = (s) => toHex(sha3_256(new TextEncoder().encode(s)));

test('SHA3-256 of the empty string matches FIPS 202', () => {
  assert.equal(hex(''), 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
});

test('SHA3-256 of "abc" matches FIPS 202', () => {
  assert.equal(hex('abc'), '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
});

test('sha3_256 matches node crypto on 1000 inputs of 0..400 bytes', () => {
  // xorshift32 keeps the inputs reproducible.
  let s = 0x9e3779b9;
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const edges = [0, 1, 135, 136, 137, 271, 272, 273, 400];
  for (let i = 0; i < 1000; i++) {
    const len = i < edges.length ? edges[i] : next() % 401;
    const buf = new Uint8Array(len);
    for (let j = 0; j < len; j++) buf[j] = next() & 255;
    const want = createHash('sha3-256').update(buf).digest('hex');
    assert.equal(toHex(sha3_256(buf)), want, `length ${len}`);
  }
});

test('acceptance keccak check passes the FIPS 202 vectors', () => {
  assert.deepEqual(checkKeccak().errors, []);
});
