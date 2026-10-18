import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { CODE, worlds, sample } from './sample.mjs';
import { u32 } from '../src/world/hash.mjs';
import { BW, NCELL, DX } from '../src/world/board.mjs';
import {
  FLOOR_ITEMS, OIL_COUNT, ROW_PERCENT, ROW_COINS, ROW_PITCH, deadEnds, floorItems, itemSpot, coinRows, rowSpot,
} from '../src/world/floor.mjs';
import { nodeXY } from '../src/game/sim.mjs';
import { boardMask, MASK_W } from '../src/game/mask.mjs';
import {
  fixtureSets, ladderPixels, sconcePixels, arrowPixels, arrowSpot, skeletonPixels, skeletonSpot, maskRow,
} from '../src/game/fixtures.mjs';
import { arrows, arrowSide, skeletons, boostSkeletons, skeletonSide } from '../src/world/signs.mjs';
import { idx, COIN, BRAZIER, FLAME, SCONCE_FLAME, JAR } from '../src/game/art.mjs';

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

// Coin rows: three coins on the floor of a corridor, chosen by hash off the built board.

/** The coin rows of `bd`, by the rule's definition: each tree link east whose `row` hash falls under 4. */
const rowCells = (world, bd) => {
  const want = [];
  for (let c = 0; c < NCELL; c++) if (bd.links && bd.links[c] & 1 && u32(world.H('row', bd.x, bd.y, c)) % 100 < 4) want.push(c);
  return want;
};

test('the constants: a row is 3 coins 7 px apart on 4 corridors in 100, and the dead-end coin list stands', () => {
  assert.deepEqual([ROW_PERCENT, ROW_COINS, ROW_PITCH], [4, 3, 7]);
  assert.deepEqual(FLOOR_ITEMS, [{ kind: 'coin', tag: 'coin', percent: 5 }, { kind: 'oil', tag: 'oil', count: OIL_COUNT }]);
});

test('coinRows holds each corridor whose row hash falls under 4, ascending, and rowSpot puts its coins at x 41, 48 and 55 of the opening', () => {
  let rock = 0, rows = 0, corridors = 0;
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    const again = createWorld(CODE, { difficulty: d });
    let at = 0;
    for (const bd of sample(d, 3)) {
      if (!bd.links) {
        rock++;
        assert.deepEqual(coinRows(world, bd), [], 'a rock board has no row');
        continue;
      }
      const want = rowCells(world, bd);
      assert.deepEqual(coinRows(world, bd), want, `rows of board (${bd.x},${bd.y})`);
      assert.equal(coinRows(world, bd), coinRows(world, bd), 'computed once per board object');
      assert.deepEqual(coinRows(again, again.board(bd.x, bd.y)), want, 'two builds agree');
      for (let c = 0; c < NCELL; c++) if (bd.links[c] & 1) corridors++;
      for (const c of want) {
        assert.ok(c % BW < BW - 1, 'no corridor crosses a board seam');
        for (let i = 0; i < 3; i++) {
          const [x, y] = rowSpot(bd, c, i);
          assert.deepEqual([x, y], [bd.x * 576 + (c % 12) * 48 + 48 + 7 * (i - 1), bd.y * 336 + ((c / 12) | 0) * 48 + 8], `coin ${i} of cell ${c}`);
          assert.equal(y, nodeXY(bd, c)[1], 'on the floor itemSpot uses');
        }
        rows++;
        at++;
      }
    }
    assert.ok(at > 0, `${d}: the sample holds rows`);
  }
  assert.ok(rock > 0 && rows > 100 && corridors > 5000, `${rock} rock boards, ${rows} rows, ${corridors} corridors`);
});

test('over tombs u -2..2 by v 0..19, a level\'s coins per tomb with rows lie 9 to 12.5 times its dead-end coins', () => {
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    let dead = 0, rows = 0;
    for (const bd of sample(d, 19)) {
      for (const { kind } of floorItems(world, bd)) if (kind === 'coin') dead++;
      rows += coinRows(world, bd).length;
    }
    const ratio = (dead + 3 * rows) / dead;
    assert.ok(ratio >= 9 && ratio <= 12.5, `${d}: ${ratio}`);
  }
});

/** The key of board pixel (x, y), y up. */
const key = (x, y) => y * 1024 + x;
/** The keys of the opaque pixels of sprite `rows` with its left column at board x and its top row at board y `top`. */
const spriteKeys = (rows, x, top) => {
  const out = [];
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) if (idx(rows[r][c]) >= 0) out.push(key(x + c, top - r));
  return out;
};

/** What a tree board draws or holds on its floor row, as a Set of pixel keys, and its rock, stair and ledge maps. */
function fixturePixels(world, bd) {
  const mask = boardMask(bd);
  const fx = fixtureSets(bd, mask);
  const pixels = new Set();
  const add = (list) => { for (const k of list) pixels.add(k); };
  for (const box of fx.ladders) add(ladderPixels(box).map(([x, y]) => key(x, y)));
  for (const [cx, y] of fx.sconces) {
    add(sconcePixels([cx, y]).map(([x, yy]) => key(x, yy)));
    for (const frame of SCONCE_FLAME) add(spriteKeys(frame, cx - 4, y + 3));
  }
  for (const { cell, dir } of arrows(world, bd)) add(arrowPixels(arrowSpot(cell, arrowSide(world, bd, cell), dir)).map(([x, y]) => key(x, y)));
  for (const list of [skeletons(world, bd), boostSkeletons(world, bd)]) {
    for (const { cell, dir } of list) {
      add(skeletonPixels(skeletonSpot(cell, skeletonSide(world, bd, cell, dir), dir)).map(([x, y]) => key(x, y)));
    }
  }
  for (const cell of world.flamesAt(bd.x, bd.y)) {
    const [x, y] = nodeXY({ x: 0, y: 0 }, cell);
    add(spriteKeys(BRAZIER, x - 8, y + 9));
    for (const frame of FLAME) add(spriteKeys(frame, x - 6, y + 20));
  }
  for (const { cell, kind } of floorItems(world, bd)) {
    const [wx, wy] = itemSpot(bd, cell);
    const x = wx - bd.x * 576, y = wy - bd.y * 336;
    if (kind === 'coin') add(spriteKeys(COIN, x - 3, y + 5));
    else add(spriteKeys(JAR, x - (wx > nodeXY(bd, cell)[0] ? 5 : 4), y + 11));
  }
  return { mask, fx, pixels };
}

/**
 * The corridors of `sample(d, 3)` whose three coins at pitch `pitch` lie on rock, a stair, a ledge or a
 * fixture, or within 12 px in x of a standing point; one string per miss.
 */
function rowMisses(d, pitch) {
  const world = worlds[d];
  const misses = [];
  let corridors = 0;
  for (const bd of sample(d, 3)) {
    if (!bd.links) continue;
    const { mask, fx, pixels } = fixturePixels(world, bd);
    for (let c = 0; c < NCELL; c++) {
      if (!(bd.links[c] & 1)) continue;
      corridors++;
      const X = (c % BW) * 48, Y = ((c / BW) | 0) * 48;
      for (let i = 0; i < 3; i++) {
        const x = X + 48 + pitch * (i - 1), y = Y + 8;
        for (const nx of [X + 24, X + 72]) if (Math.abs(x - nx) <= 12) misses.push(`${d} board (${bd.x},${bd.y}) cell ${c} coin ${i} lies within 12 px of a standing point`);
        for (let r = 0; r < COIN.length; r++) {
          for (let k = 0; k < COIN[r].length; k++) {
            if (idx(COIN[r][k]) < 0) continue;
            const px = x - 3 + k, py = y + 5 - r, at = maskRow(py) * MASK_W + px;
            const hit = mask[at] === 1 ? 'rock' : fx.stairs[at] ? 'a stair' : fx.ledge[at] ? 'a ledge' : pixels.has(key(px, py)) ? 'a fixture' : null;
            if (hit) misses.push(`${d} board (${bd.x},${bd.y}) cell ${c} coin ${i} pixel (${k}, ${r}) lies on ${hit}`);
          }
        }
      }
    }
  }
  return { misses, corridors };
}

test('over every corridor of tombs u -2..2 by v 0..3, row or not, the coins\' pixels lie clear of rock, stairs, ledges and fixtures, and 12 px from both standing points', () => {
  for (const d of DIFFICULTIES) {
    const { misses, corridors } = rowMisses(d, ROW_PITCH);
    assert.ok(corridors > 1500, `${d}: ${corridors} corridors`);
    assert.deepEqual(misses.slice(0, 3), [], `${d}: ${misses.length} misses`);
  }
});

test('a pitch of 8 puts a coin on a fixture or within reach of a standing point', () => {
  const found = DIFFICULTIES.reduce((n, d) => n + rowMisses(d, 8).misses.length, 0);
  assert.ok(found > 0, `${found} misses at pitch 8`);
});
