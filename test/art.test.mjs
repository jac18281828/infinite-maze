import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WALL } from '../src/game/art.mjs';

test('the back wall\'s plaster tile has a closed, symmetric panel frame', () => {
  const rows = WALL[0];
  assert.equal(rows.length, 16);
  for (const row of rows) assert.equal(row.length, 16);
  rows.forEach((row, y) => assert.equal(row, [...row].reverse().join(''), `row ${y} mirrors itself`));
  const at = (x, y) => rows[y][x];
  for (let i = 0; i < 16; i++) {
    for (const [x, y] of [[i, 0], [i, 15], [0, i], [15, i]]) assert.equal(at(x, y), 'd', `outer ring (${x}, ${y})`);
  }
  for (let i = 1; i <= 14; i++) {
    for (const [x, y] of [[i, 1], [i, 14], [1, i], [14, i]]) assert.equal(at(x, y), 'e', `inner ring (${x}, ${y})`);
  }
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (Math.min(x, y, 15 - x, 15 - y) < 2) assert.notEqual(at(x, y), '.', `(${x}, ${y}) on the two outer rings`);
    }
  }
});
