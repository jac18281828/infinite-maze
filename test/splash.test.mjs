import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MILESTONE, RANKS, rankName } from '../src/game/ranks.mjs';
import { milestonePayout } from '../src/game/wallet.mjs';
import { FONT } from '../src/game/art.mjs';

test('rankName follows the owner\'s table to k = 10, then PHARAOH and a numeral of k - 9', () => {
  const table = [
    'TORCHBEARER', 'RELIC HUNTER', 'TOMB DELVER', 'SCARAB SEEKER', 'PATHFINDER',
    'ROYAL SCRIBE', 'HIGH PRIEST', 'GRAND VIZIER', 'HEIR OF THE NILE', 'PHARAOH',
  ];
  assert.equal(MILESTONE, 100);
  assert.deepEqual(RANKS, table);
  table.forEach((name, i) => assert.equal(rankName(i + 1), name, `k = ${i + 1}`));
  assert.equal(rankName(11), 'PHARAOH II');
  assert.equal(rankName(12), 'PHARAOH III');
  assert.equal(rankName(13), 'PHARAOH IV');
  assert.equal(rankName(100), 'PHARAOH XCI');
  assert.equal(rankName(4008), 'PHARAOH MMMCMXCIX');
  assert.equal(rankName(4009), 'PHARAOH MMMM');
  assert.equal(rankName(4010), 'PHARAOH MMMMI');
});

test('every rank name uses only characters the font draws', () => {
  for (let k = 1; k <= 200; k++) {
    for (const ch of rankName(k)) assert.ok(FONT[ch], `k = ${k}: ${JSON.stringify(ch)} is in the font`);
  }
});

test('the splash screen draws only characters the font draws', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const fn = src.match(/function drawSplash\([^)]*\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, 'drawSplash found');
  const rows = [...fn[0].matchAll(/r\.text\((`[^`]*`|'[^']*'),/g)].map((m) => m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, ''));
  // The rank row passes a variable; the rank test covers its characters.
  assert.equal(rows.length, 3, 'the milestone, the coins and the hint');
  for (const row of rows) for (const ch of row) assert.ok(FONT[ch], `${JSON.stringify(ch)} in ${JSON.stringify(row)} is in the font`);
});

test('a crossing of k pays 100 x k once past the record', () => {
  for (const [record, count, pays] of [[99, 100, 100], [150, 250, 200], [0, 250, 300], [100, 100, 0], [100, 101, 0], [0, 99, 0], [250, 100, 0]]) {
    assert.equal(milestonePayout(record, count), pays, `${record} ${count}`);
  }
});
