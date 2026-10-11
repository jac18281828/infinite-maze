import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { CODE, worlds, sample } from './sample.mjs';
import { u32 } from '../src/world/hash.mjs';
import { NCELL, DX } from '../src/world/board.mjs';
import { FLOOR_ITEMS, deadEnds, floorItems, itemSpot } from '../src/world/floor.mjs';
import { nodeXY } from '../src/game/sim.mjs';

const popcount1 = (m) => m !== 0 && (m & (m - 1)) === 0;

test('floor items lie on dead-end cells only, and a dead-end cell holds a coin exactly when its hash passes 5', () => {
  let rock = 0, flameKept = 0, coins = 0;
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    const again = createWorld(CODE, { difficulty: d });
    for (const bd of sample(d, 3)) {
      const items = floorItems(world, bd);
      if (!bd.links) {
        rock++;
        assert.deepEqual(items, [], 'a rock board has none');
        assert.deepEqual(deadEnds(world, bd), []);
        continue;
      }
      const flames = world.flamesAt(bd.x, bd.y);
      // The definition, read cell by cell off the board.
      const want = [];
      for (let c = 0; c < NCELL; c++) {
        if (!popcount1(bd.links[c]) || bd.doorMask[c] !== 0) continue;
        if (flames.includes(c)) { flameKept++; continue; }
        want.push(c);
      }
      assert.deepEqual(deadEnds(world, bd), want, `dead ends of board (${bd.x},${bd.y})`);
      const coinCells = want.filter((c) => u32(world.H('coin', bd.x, bd.y, c)) % 100 < 5);
      assert.deepEqual(items, coinCells.map((cell) => ({ cell, kind: 'coin' })), `coins of board (${bd.x},${bd.y})`);
      coins += items.length;
      assert.deepEqual(floorItems(again, again.board(bd.x, bd.y)), items, 'two builds agree');
    }
  }
  assert.ok(rock > 0 && flameKept > 0 && coins > 100, `the sample holds rock boards, flame-held single-link cells and coins (${rock}, ${flameKept}, ${coins})`);
});

test('a dead-end cell takes the first kind in the list whose hash passes, so two items never share a cell', () => {
  const world = worlds.medium;
  const jar = { kind: 'jar', tag: 'jar', percent: 100 };
  let coinCells = 0, jarCells = 0;
  for (const bd of sample('medium', 3)) {
    const items = floorItems(world, bd, [...FLOOR_ITEMS, jar]);
    assert.deepEqual(items.map((it) => it.cell), deadEnds(world, bd), 'every dead end holds one item');
    for (const { cell, kind } of items) {
      const coin = u32(world.H('coin', bd.x, bd.y, cell)) % 100 < 5;
      assert.equal(kind, coin ? 'coin' : 'jar');
      if (coin) coinCells++; else jarCells++;
    }
  }
  assert.ok(coinCells > 0 && jarCells > coinCells);
  assert.deepEqual(FLOOR_ITEMS, [{ kind: 'coin', tag: 'coin', percent: 5 }]);
});

test('over tombs u -2..2 by v 0..19 the share of dead-end cells holding a coin lies in [0.035, 0.065] at each level', () => {
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    let dead = 0, coins = 0;
    for (const bd of sample(d, 19)) {
      dead += deadEnds(world, bd).length;
      coins += floorItems(world, bd).length;
    }
    assert.ok(dead > 3000);
    const share = coins / dead;
    assert.ok(share >= 0.035 && share <= 0.065, `${d}: ${share}`);
  }
});

test('itemSpot is the standing point 12 px from the cell centre, away from its one link, or east for a ladder', () => {
  let n = 0;
  const seen = new Set();
  for (const d of DIFFICULTIES) {
    for (const bd of sample(d, 3)) {
      for (const cell of deadEnds(worlds[d], bd)) {
        const link = Math.log2(bd.links[cell]);
        const [nx, ny] = nodeXY(bd, cell);
        const dx = DX[link] === 0 ? 12 : -12 * DX[link];
        assert.deepEqual(itemSpot(bd, cell), [nx + dx, ny], `board (${bd.x},${bd.y}) cell ${cell}`);
        seen.add(link);
        n++;
      }
    }
  }
  assert.ok(n > 300 && seen.size === 8, 'every link direction appears');
});
