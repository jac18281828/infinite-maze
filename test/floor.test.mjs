import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { CODE, worlds, sample } from './sample.mjs';
import { u32 } from '../src/world/hash.mjs';
import { NCELL, DX } from '../src/world/board.mjs';
import { FLOOR_ITEMS, OIL_PERCENT, deadEnds, floorItems, itemSpot } from '../src/world/floor.mjs';
import { nodeXY } from '../src/game/sim.mjs';

const popcount1 = (m) => m !== 0 && (m & (m - 1)) === 0;

test('floor items lie on dead-end cells only; a dead-end cell holds a coin when its hash passes 5, else a jar when its oil hash passes its level\'s rate', () => {
  let rock = 0, flameKept = 0, coins = 0, jars = 0, both = 0;
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
      const coin = (c) => u32(world.H('coin', bd.x, bd.y, c)) % 100 < 5;
      const oil = (c) => u32(world.H('oil', bd.x, bd.y, c)) % 100 < OIL_PERCENT[d];
      const cells = want.filter((c) => coin(c) || oil(c));
      assert.deepEqual(items, cells.map((cell) => ({ cell, kind: coin(cell) ? 'coin' : 'oil' })), `items of board (${bd.x},${bd.y})`);
      assert.equal(new Set(items.map((it) => it.cell)).size, items.length, 'no cell holds two items');
      coins += items.filter((it) => it.kind === 'coin').length;
      jars += items.filter((it) => it.kind === 'oil').length;
      both += want.filter((c) => coin(c) && oil(c)).length;
      assert.deepEqual(floorItems(again, again.board(bd.x, bd.y)), items, 'two builds agree');
    }
  }
  assert.ok(rock > 0 && flameKept > 0 && coins > 100 && jars > 100 && both > 0,
    `the sample holds rock boards, flame-held single-link cells, coins, jars and a cell where both hashes pass (${rock}, ${flameKept}, ${coins}, ${jars}, ${both})`);
});

test('a dead-end cell takes the first kind in the list whose hash passes, so two items never share a cell', () => {
  const world = worlds.medium;
  const rest = { kind: 'rest', tag: 'rest', percent: 100 };
  let coinCells = 0, restCells = 0;
  for (const bd of sample('medium', 3)) {
    const items = floorItems(world, bd, [...FLOOR_ITEMS, rest]);
    assert.deepEqual(items.map((it) => it.cell), deadEnds(world, bd), 'every dead end holds one item');
    for (const { cell, kind } of items) {
      const coin = u32(world.H('coin', bd.x, bd.y, cell)) % 100 < 5;
      const oil = u32(world.H('oil', bd.x, bd.y, cell)) % 100 < OIL_PERCENT.medium;
      assert.equal(kind, coin ? 'coin' : oil ? 'oil' : 'rest');
      if (coin) coinCells++; else restCells++;
    }
  }
  assert.ok(coinCells > 0 && restCells > coinCells);
  assert.deepEqual(FLOOR_ITEMS, [{ kind: 'coin', tag: 'coin', percent: 5 }, { kind: 'oil', tag: 'oil', percent: OIL_PERCENT }]);
});

test('the jar rate is 10 at EASY, 7 at MEDIUM, 5 at HARD and 4 at ULTIMATE, not one flat figure', () => {
  assert.deepEqual(OIL_PERCENT, { easy: 10, medium: 7, hard: 5, ultimate: 4 });
});

test('over tombs u -2..2 by v 0..19, v 0..39 at EASY, the share of dead-end cells holding a coin lies in [0.035, 0.065] and a jar within 1.5 points of 0.95 times its level\'s rate at each level', () => {
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    let dead = 0, coins = 0, jars = 0;
    // EASY's 2x2 tombs need twice the rows to pass 3,000 dead-end cells.
    for (const bd of sample(d, d === 'easy' ? 39 : 19)) {
      dead += deadEnds(world, bd).length;
      for (const { kind } of floorItems(world, bd)) { if (kind === 'coin') coins++; else jars++; }
    }
    assert.ok(dead > 3000);
    const share = coins / dead;
    assert.ok(share >= 0.035 && share <= 0.065, `${d}: ${share}`);
    // A jar needs a dead end whose coin hash fails: 95% of them.
    const jarShare = jars / dead, want = 0.0095 * OIL_PERCENT[d];
    assert.ok(Math.abs(jarShare - want) <= 0.015, `${d} jars: ${jarShare}, want ${want} within 0.015`);
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
