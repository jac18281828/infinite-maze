import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { CODE, worlds, sample } from './sample.mjs';
import { u32 } from '../src/world/hash.mjs';
import { NCELL, DX } from '../src/world/board.mjs';
import { FLOOR_ITEMS, OIL_COUNT, deadEnds, floorItems, itemSpot } from '../src/world/floor.mjs';
import { nodeXY } from '../src/game/sim.mjs';

const popcount1 = (m) => m !== 0 && (m & (m - 1)) === 0;

/** Tree boards of `sample(d, v1)`. */
const treeBoards = (d, v1) => sample(d, v1).filter((bd) => bd.links);
const coinHit = (world, bd, c) => u32(world.H('coin', bd.x, bd.y, c)) % 100 < 5;
/** Dead-end cells of `bd` in oil-rank order, the lower cell first on a tie. */
const oilRank = (world, bd, cells) => cells
  .map((c) => ({ c, h: u32(world.H('oil', bd.x, bd.y, c)) }))
  .sort((a, b) => a.h - b.h || a.c - b.c)
  .map(({ c }) => c);

test('every tree board holds its level\'s count of jars, or one on each free cell when it has fewer', () => {
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    let short = 0;
    for (const bd of treeBoards(d, 19)) {
      const items = floorItems(world, bd);
      const jars = items.filter((it) => it.kind === 'oil').length;
      const coins = items.filter((it) => it.kind === 'coin').length;
      const free = deadEnds(world, bd).length - coins;
      assert.ok(jars > 0, `${d} board (${bd.x},${bd.y}) holds a jar`);
      assert.equal(jars, Math.min(OIL_COUNT[d], free), `${d} board (${bd.x},${bd.y}) holds its count`);
      if (free < OIL_COUNT[d]) short++;
    }
    if (d === 'easy') assert.ok(short > 0, 'EASY sample holds a board short of its count');
    else assert.equal(short, 0, `${d} has none short`);
  }
});

test('floor items lie on dead-end cells only: a coin where its hash passes 5, a jar on each of the first `count` free cells by oil hash', () => {
  let rock = 0, flameKept = 0, shortEasy = 0;
  const coinFirst = {};
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    const again = createWorld(CODE, { difficulty: d });
    coinFirst[d] = 0;
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
      const coins = want.filter((c) => coinHit(world, bd, c));
      const free = want.filter((c) => !coins.includes(c));
      const jars = oilRank(world, bd, free).slice(0, OIL_COUNT[d]);
      assert.deepEqual(items.filter((it) => it.kind === 'coin').map((it) => it.cell), coins, `coins of board (${bd.x},${bd.y})`);
      assert.deepEqual(items.filter((it) => it.kind === 'oil').map((it) => it.cell), jars.sort((a, b) => a - b), `jars of board (${bd.x},${bd.y})`);
      assert.deepEqual(items.map((it) => it.cell), [...items.map((it) => it.cell)].sort((a, b) => a - b), 'ascending by cell');
      assert.equal(new Set(items.map((it) => it.cell)).size, items.length, 'no cell holds two items');
      assert.deepEqual(floorItems(again, again.board(bd.x, bd.y)), items, 'two builds agree');
      if (d === 'easy' && free.length < OIL_COUNT.easy) shortEasy++;
      // A coin on one of the `count` lowest-ranked dead ends moves the jar on.
      if (oilRank(world, bd, want).slice(0, OIL_COUNT[d]).some((c) => coins.includes(c))) coinFirst[d]++;
    }
  }
  assert.ok(rock > 0 && flameKept > 0, `the sample holds rock boards and flame-held single-link cells (${rock}, ${flameKept})`);
  assert.ok(shortEasy > 0, 'a board at EASY is short of its count');
  for (const d of DIFFICULTIES) assert.ok(coinFirst[d] > 0, `${d}: a coin lies on a lowest-ranked dead end`);
});

test('OIL_COUNT is 2 at EASY and 1 at MEDIUM, HARD and ULTIMATE, and FLOOR_ITEMS lists the coin then the jar', () => {
  assert.deepEqual(OIL_COUNT, { easy: 2, medium: 1, hard: 1, ultimate: 1 });
  assert.deepEqual(FLOOR_ITEMS, [{ kind: 'coin', tag: 'coin', percent: 5 }, { kind: 'oil', tag: 'oil', count: OIL_COUNT }]);
});

test('rows claim cells in list order: a large count row after the coin fills every coinless dead end, a percent-100 row fills what is left', () => {
  const world = worlds.medium;
  const all = { kind: 'all', tag: 'oil', count: 1000 };
  const rest = { kind: 'rest', tag: 'rest', percent: 100 };
  let coinCells = 0, jarCells = 0;
  for (const bd of sample('medium', 3)) {
    const dead = deadEnds(world, bd);
    const items = floorItems(world, bd, [FLOOR_ITEMS[0], all]);
    assert.deepEqual(items.map((it) => it.cell), dead, 'every dead end holds one item');
    for (const { cell, kind } of items) {
      const coin = coinHit(world, bd, cell);
      assert.equal(kind, coin ? 'coin' : 'all');
      if (coin) coinCells++;
    }
    const filled = floorItems(world, bd, [...FLOOR_ITEMS, rest]);
    assert.deepEqual(filled.map((it) => it.cell), dead, 'the percent row fills the rest');
    const jars = floorItems(world, bd).filter((it) => it.kind === 'oil').map((it) => it.cell);
    for (const { cell, kind } of filled) {
      const want = coinHit(world, bd, cell) ? 'coin' : jars.includes(cell) ? 'oil' : 'rest';
      assert.equal(kind, want);
      if (kind === 'oil') jarCells++;
    }
  }
  assert.ok(coinCells > 0 && jarCells > 0);
});

test('over tombs u -2..2 by v 0..19, v 0..39 at EASY, the share of dead-end cells holding a coin lies in [0.035, 0.065] at each level', () => {
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    let dead = 0, coins = 0;
    // EASY's 2x2 tombs need twice the rows to pass 3,000 dead-end cells.
    for (const bd of sample(d, d === 'easy' ? 39 : 19)) {
      dead += deadEnds(world, bd).length;
      for (const { kind } of floorItems(world, bd)) if (kind === 'coin') coins++;
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
