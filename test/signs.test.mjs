import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, boardCoords, cellPath } from '../src/world/world.mjs';
import { DX, DY, NCELL, cellNeighbor } from '../src/world/board.mjs';
import { BDX, BDY, DIFFICULTIES } from '../src/world/band.mjs';
import { u32 } from '../src/world/hash.mjs';
import {
  SIGN_MOD, SKELETON_THRESHOLD, ARROW_THRESHOLD, junctions, arrows, arrowSide, skeletons, boostSkeletons, skeletonSide,
} from '../src/world/signs.mjs';
import { ARROWS, SKELETONS, artSets } from '../src/game/art.mjs';

// The oracle holds its own copy of the rule, never the module's constants.
const MOD = 1024;
const THRESHOLD = { easy: 94, medium: 30, hard: 17, ultimate: 11 };
const ARROW_BAND = { easy: 85, medium: 64, hard: 43, ultimate: 32 };
const ARROW_SHARE = { easy: 1 / 12, medium: 1 / 16, hard: 1 / 24, ultimate: 1 / 32 };
const worlds = Object.fromEntries(DIFFICULTIES.map((d) => [d, createWorld('00000000', { difficulty: d })]));

/** Boards of tombs u u0..u1 by v v0..v1 at `level`. */
function boardsOf(level, v0, v1, u0 = -2, u1 = 2) {
  const w = worlds[level], out = [];
  for (let v = v0; v <= v1; v++) {
    for (let u = u0; u <= u1; u++) {
      for (let i = 0; i < w.size.w * w.size.h; i++) {
        const { x, y } = boardCoords(u, v, i, w.size);
        out.push(w.board(x, y));
      }
    }
  }
  return out;
}

const bits = (m) => { let n = 0; for (; m; m &= m - 1) n++; return n; };
const outCell = (bd) => bd.doors.find((d) => d.dir === bd.bDir).cell;

/** In-cells of route board `bd`, from the spec's G2 and the far board's own exit. */
function inCells(world, bd) {
  const ins = new Map();
  if (bd.aDir === -1) ins.set(bd.a, 'source');
  for (const door of bd.doors) {
    const far = world.board(bd.x + BDX[door.dir], bd.y + BDY[door.dir]);
    if (far.kind === 'route' && far.bDir === (door.dir ^ 2)) ins.set(door.cell, door.dir === bd.aDir ? 'back' : 'merge');
  }
  return ins;
}

/** A stub: a door-free cell with one link, a source board's flame cell excepted. */
const isStub = (bd, c) => bits(bd.links[c]) === 1 && !bd.doorMask[c] && !(bd.aDir === -1 && c === bd.a);
/** Ways out of cell `c`: its links and doors, less its links into a stub. */
function choices(bd, c) {
  let n = bits(bd.links[c]) + bits(bd.doorMask[c]);
  for (let d = 0; d < 8; d++) if ((bd.links[c] & (1 << d)) && isStub(bd, cellNeighbor(c, d))) n--;
  return n;
}

/** Cells of the way on of route board `bd`, the out-door excepted, with the direction toward it. */
function wayCells(world, bd) {
  const o = outCell(bd), got = new Map();
  for (const c of inCells(world, bd).keys()) {
    const path = cellPath(bd.links, c, o);
    for (let k = 0; k + 1 < path.cells.length; k++) got.set(path.cells[k], path.dirs[k]);
  }
  return got;
}

/** The oracle's sign junctions of a route board: cell -> direction. */
function expected(world, bd) {
  const got = new Map();
  for (const [cell, dir] of wayCells(world, bd)) if (choices(bd, cell) >= 3) got.set(cell, dir);
  return got;
}

const pointerLists = (w, bd) => [skeletons(w, bd), boostSkeletons(w, bd), arrows(w, bd)];
const hashOf = (w, bd, cell) => u32(w.H('sign', bd.x, bd.y, cell)) % 1024;

test('each skeleton tier holds 0.8 to 1.2 per tomb at every level over tombs u -5..5 by v 0..39, and the arrow share of junctions lies within 15% of 1/12, 1/16, 1/24 and 1/32', () => {
  const started = performance.now();
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    let one = 0, two = 0;
    for (const bd of boardsOf(level, 0, 39, -5, 5)) {
      one += skeletons(w, bd).length;
      two += boostSkeletons(w, bd).length;
    }
    const tombs = 11 * 40;
    assert.ok(one / tombs >= 0.8 && one / tombs <= 1.2, `${level}: ${one / tombs} tier-1 skeletons per tomb`);
    assert.ok(two / tombs >= 0.8 && two / tombs <= 1.2, `${level}: ${two / tombs} tier-2 skeletons per tomb`);
    let junc = 0, arrowed = 0;
    // EASY's 2x2 tombs need twice the rows to pass 2,000 junctions.
    for (const bd of boardsOf(level, 0, level === 'easy' ? 39 : 19)) {
      junc += junctions(w, bd).length;
      arrowed += arrows(w, bd).length;
    }
    assert.ok(junc > 2000, `${level}: ${junc} sign junctions`);
    const share = arrowed / junc;
    assert.ok(Math.abs(share - ARROW_SHARE[level]) <= 0.15 * ARROW_SHARE[level], `${level}: arrow share ${share} (${arrowed}/${junc})`);
  }
  console.log(`# rate test: ${((performance.now() - started) / 1000).toFixed(1)} s`);
});

/** Whether cells p and q of one board lie within Chebyshev distance 1 (12 cells to a row). */
const within1 = (p, q) => Math.max(Math.abs((p % 12) - (q % 12)), Math.abs(Math.floor(p / 12) - Math.floor(q / 12))) <= 1;

/** The oracle's band candidates of a board by list, ascending by cell, before spacing. */
function candidates(w, bd, level) {
  const t = THRESHOLD[level], a = ARROW_BAND[level], out = { first: [], second: [], third: [] };
  if (bd.kind !== 'route') return out;
  for (const [cell, dir] of [...expected(w, bd)].sort((p, q) => p[0] - q[0])) {
    const h = hashOf(w, bd, cell);
    if (h < t) out.first.push({ cell, dir });
    else if (h < 2 * t) out.second.push({ cell, dir });
    else if (h < 2 * t + a) out.third.push({ cell, dir });
  }
  return out;
}

/** The oracle's survivors: `order` names the lists in turn, each candidate standing unless a pointer already standing is within 1. */
function survivors(cands, order) {
  const stood = [], out = { first: [], second: [], third: [] };
  for (const name of order) {
    for (const c of cands[name]) {
      if (stood.some((s) => within1(s.cell, c.cell))) continue;
      stood.push(c);
      out[name].push(c);
    }
  }
  return out;
}

test('each list holds exactly the band candidates that stand under the spacing rule: tier 1, then arrows, then tier 2, each by cell, never in two lists', () => {
  assert.equal(SIGN_MOD, MOD);
  assert.deepEqual(SKELETON_THRESHOLD, THRESHOLD);
  assert.deepEqual(ARROW_THRESHOLD, ARROW_BAND);
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    let crossPairs = 0, sensitive = 0, kept = 0;
    for (const bd of boardsOf(level, 0, 5)) {
      const lists = { first: skeletons(w, bd), second: boostSkeletons(w, bd), third: arrows(w, bd) };
      const cands = candidates(w, bd, level);
      const want = survivors(cands, ['first', 'third', 'second']);
      for (const name of Object.keys(lists)) assert.deepEqual(lists[name], want[name], `${level} board ${bd.p}: ${name} list`);
      // A candidate pair within 1 drawn from two lists makes the order matter.
      const all = Object.entries(cands).flatMap(([name, list]) => list.map((c) => ({ ...c, name })));
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) if (all[i].name !== all[j].name && within1(all[i].cell, all[j].cell)) crossPairs++;
      }
      // Tier 2 first would stand different pointers on a board with such a pair.
      if (JSON.stringify(survivors(cands, ['second', 'first', 'third'])) !== JSON.stringify(want)) sensitive++;
      for (const list of Object.values(lists)) {
        assert.deepEqual(list.map((s) => s.cell), list.map((s) => s.cell).sort((p, q) => p - q));
        kept += list.length;
      }
      const every = Object.values(lists).flat().map((s) => s.cell);
      assert.equal(new Set(every).size, every.length, 'no junction holds two pointers');
      if (bd.kind === 'dead') for (const list of Object.values(lists)) assert.deepEqual(list, []);
    }
    assert.ok(crossPairs >= 1, `${level}: ${crossPairs} candidate pairs within 1 from two lists`);
    assert.ok(sensitive >= 1, `${level}: no board where the order matters`);
    assert.ok(kept >= 40, `${level}: ${kept} pointers`);
  }
});

test('no two pointers of a board, across all three lists, lie within one cell, and the candidates held such pairs at every level', () => {
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    let pairs = 0, boards = 0;
    for (const bd of boardsOf(level, 0, 19)) {
      const c = candidates(w, bd, level);
      const all = [...c.first, ...c.second, ...c.third];
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (within1(all[i].cell, all[j].cell)) pairs++;
      const got = [...skeletons(w, bd), ...boostSkeletons(w, bd), ...arrows(w, bd)];
      for (let i = 0; i < got.length; i++) {
        for (let j = i + 1; j < got.length; j++) assert.ok(!within1(got[i].cell, got[j].cell), `${level} board ${bd.p}: cells ${got[i].cell} and ${got[j].cell}`);
      }
      boards++;
    }
    assert.ok(pairs >= 1, `${level}: ${pairs} candidate pairs within 1 over ${boards} boards`);
  }
});

test('arrowSide is bit 31 of the junction\'s hash at every arrow junction of the band sample', () => {
  let n = 0;
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    for (const bd of boardsOf(level, 0, 5)) {
      for (const { cell } of arrows(w, bd)) {
        assert.equal(arrowSide(w, bd, cell), u32(w.H('sign', bd.x, bd.y, cell)) >>> 31, `${level} board ${bd.p} cell ${cell}`);
        n++;
      }
    }
  }
  assert.ok(n >= 60, `${n} arrow junctions`);
});

test('skeletonSide is the corner the way on, the hash and the gallery give, and the sample holds every case at every level', () => {
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    const cases = { right: 0, left: 0, upHash0: 0, upHash1: 0, fallback: 0 };
    for (const bd of boardsOf(level, 0, 5)) {
      for (const { cell, dir } of junctions(w, bd)) {
        const bit = u32(w.H('sign', bd.x, bd.y, cell)) >>> 31;
        // A right way prefers the left corner, a left way the right, else the hash's.
        const prefer = dir === 0 ? 0 : dir === 2 ? 1 : bit;
        // Link bits: NE 16, NW 32, SW 64, SE 128. A gallery toward a side blocks its corner.
        const toRight = (bd.links[cell] & (16 | 128)) !== 0, toLeft = (bd.links[cell] & (32 | 64)) !== 0;
        const blocked = prefer ? toRight : toLeft;
        const want = blocked ? 1 - prefer : prefer;
        assert.equal(skeletonSide(w, bd, cell, dir), want, `${level} board ${bd.p} cell ${cell} dir ${dir}`);
        if (blocked) cases.fallback++;
        else if (dir === 0) cases.right++;
        else if (dir === 2) cases.left++;
        else if (dir === 1 || dir === 3) cases[bit ? 'upHash1' : 'upHash0']++;
      }
    }
    for (const [name, n] of Object.entries(cases)) assert.ok(n >= 60, `${level}: ${n} ${name} cases`);
  }
});

test('junctions lists exactly the cells on a path from an in-cell to the out-door, the out-door excepted, with three ways out', () => {
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    const n = { fewLinks: 0, inCell: 0, outCell: 0, merging: 0 };
    // Rows 0..5: HARD's first merging junction lies above row 3.
    for (const bd of boardsOf(level, 0, 5)) {
      const got = junctions(w, bd);
      if (bd.kind !== 'route') { assert.deepEqual(got, []); continue; }
      const want = expected(w, bd);
      assert.deepEqual(got, [...want].sort((p, q) => p[0] - q[0]).map(([cell, dir]) => ({ cell, dir })), `${level} board ${bd.p}`);
      const ins = inCells(w, bd), o = outCell(bd);
      const main = new Set(cellPath(bd.links, bd.a, o).cells);
      for (const { cell } of got) {
        if (bits(bd.links[cell]) < 3 && !ins.has(cell)) n.fewLinks++;
        if (ins.has(cell)) n.inCell++;
        if (!main.has(cell)) n.merging++;
      }
      if (bits(bd.links[o]) + bits(bd.doorMask[o]) >= 3) n.outCell++;
      assert.ok(!got.some((j) => j.cell === o), 'the out-door is no sign junction');
    }
    for (const k of Object.keys(n)) assert.ok(n[k] >= 1, `${level}: no ${k} case`);
  }
});

test('every pointer\'s dir is the first step of its cell\'s path to the out-door, for arrows and both skeleton tiers, over seeds 00000000, 00000004 and 00000009', () => {
  for (const seed of ['00000000', '00000004', '00000009']) {
    const dirs = new Set();
    let n = 0;
    for (const level of DIFFICULTIES) {
      const w = createWorld(seed, { difficulty: level });
      for (let v = 0; v <= 19; v++) {
        for (let u = -2; u <= 2; u++) {
          for (let i = 0; i < w.size.w * w.size.h; i++) {
            const { x, y } = boardCoords(u, v, i, w.size);
            const bd = w.board(x, y);
            for (const { cell, dir } of [...skeletons(w, bd), ...boostSkeletons(w, bd), ...arrows(w, bd)]) {
              assert.equal(bd.kind, 'route');
              const path = cellPath(bd.links, cell, outCell(bd));
              assert.equal(dir, path.dirs[0], `${seed} ${level} board ${bd.p} cell ${cell}`);
              const next = w.step(bd, cell, dir);
              assert.equal(next.board, bd);
              assert.equal(next.cell, path.cells[1]);
              dirs.add(dir);
              n++;
            }
          }
        }
      }
    }
    assert.ok(n > 1400, `${seed}: ${n} pointers`);
    assert.equal(dirs.size, 8, `${seed}: the sample holds a pointer for each direction`);
  }
});

test('dead-end boards carry no pointer, and the sample holds dead-end cells with three or more ways out', () => {
  let dead = 0, cells = 0;
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    for (const bd of boardsOf(level, 0, 3)) {
      if (bd.kind !== 'dead') continue;
      dead++;
      assert.deepEqual(junctions(w, bd), []);
      for (const list of [arrows, skeletons, boostSkeletons]) assert.deepEqual(list(w, bd), []);
      for (let c = 0; c < NCELL; c++) if (bits(bd.links[c]) + bits(bd.doorMask[c]) >= 3) cells++;
    }
  }
  assert.ok(dead > 20 && cells >= 210, `${dead} dead-end boards, ${cells} cells`);
});

test('the eight glyphs differ pairwise, fit 7 x 7 and point their direction', () => {
  assert.equal(ARROWS.length, 8);
  assert.equal(artSets().arrow, ARROWS);
  assert.equal(new Set(ARROWS.map((g) => g.join('/'))).size, 8);
  ARROWS.forEach((rows, d) => {
    assert.ok(rows.length <= 7 && rows.every((r) => r.length <= 7));
    // The tip is the one opaque pixel farthest along the direction (y runs up).
    let best = -Infinity, tips = 0;
    rows.forEach((r, y) => [...r].forEach((ch, x) => {
      if (ch === '.') return;
      const k = x * DX[d] - y * DY[d];
      if (k > best) { best = k; tips = 1; } else if (k === best) tips++;
    }));
    assert.equal(tips, 1, `glyph ${d} has one tip`);
  });
});

test('a way-on cell with three links and doors but under three real choices is no junction and holds no pointer', () => {
  const want = { easy: 7, medium: 4, hard: 6, ultimate: 5 };
  let banded = 0;
  for (const level of DIFFICULTIES) {
    const w = worlds[level], t = THRESHOLD[level], a = ARROW_BAND[level];
    let n = 0;
    for (const bd of boardsOf(level, 0, 19)) {
      if (bd.kind !== 'route') continue;
      const got = new Set(junctions(w, bd).map((j) => j.cell));
      for (const [cell] of wayCells(w, bd)) {
        if (bits(bd.links[cell]) + bits(bd.doorMask[cell]) < 3 || choices(bd, cell) >= 3) continue;
        n++;
        assert.ok(!got.has(cell), `${level} board ${bd.p} cell ${cell}: a junction`);
        for (const list of pointerLists(w, bd)) assert.ok(!list.some((s) => s.cell === cell), `${level} board ${bd.p} cell ${cell}: a pointer`);
        if (hashOf(w, bd, cell) < 2 * t + a) banded++;
      }
    }
    assert.equal(n, want[level], `${level}: cells without a choice`);
  }
  assert.ok(banded >= 6, `${banded} removed cells with a hash in a pointer band`);
});

test('a way-on cell linked to the source board\'s flame cell stays a junction when its other ways, less their stubs, number two', () => {
  const want = { easy: 3, medium: 5, hard: 6, ultimate: 3 };
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    let n = 0;
    for (const bd of boardsOf(level, 0, 19)) {
      if (bd.kind !== 'route' || bd.aDir !== -1 || bits(bd.links[bd.a]) !== 1 || bd.doorMask[bd.a]) continue;
      const got = new Set(junctions(w, bd).map((j) => j.cell));
      for (const [cell] of wayCells(w, bd)) {
        let toFlame = 0;
        for (let d = 0; d < 8; d++) if ((bd.links[cell] & (1 << d)) && cellNeighbor(cell, d) === bd.a) toFlame++;
        // choices counts the flame link as a way; the other ways, less their stubs, are the rest.
        if (toFlame !== 1 || choices(bd, cell) - 1 !== 2) continue;
        n++;
        assert.ok(got.has(cell), `${level} board ${bd.p} cell ${cell}: the flame cell was counted as a stub`);
      }
    }
    assert.equal(n, want[level], `${level}: flame-cell cases`);
  }
});

test('the owner\'s case: seed 00000004 at HARD, board (7, 69) in tomb (1, 17), cell 59 holds a door and a stub and offers no choice', () => {
  const w = createWorld('00000004', { difficulty: 'hard' }), bd = w.board(7, 69);
  assert.deepEqual([Math.floor(7 / w.size.w), Math.floor(69 / w.size.h)], [1, 17]);
  assert.equal(bd.kind, 'route');
  assert.equal(bd.links[59], (1 << 3) | (1 << 5), 'links S and NW');
  assert.equal(bd.doorMask[59], 1, 'a door E');
  assert.equal(cellNeighbor(59, 5), 70);
  assert.equal(bd.links[70], 1 << 7, 'cell 70 holds one link');
  assert.equal(bd.doorMask[70], 0, 'and no door');
  assert.ok(!junctions(w, bd).some((j) => j.cell === 59));
  for (const list of pointerLists(w, bd)) assert.ok(!list.some((s) => s.cell === 59));
});

test('the four poses differ pairwise, fill 7 x 10 and put their one fingertip where its way on says', () => {
  assert.equal(SKELETONS.length, 4);
  assert.equal(artSets().skeleton, SKELETONS);
  assert.equal(new Set(SKELETONS.map((p) => p.join('/'))).size, 4);
  // Poses run E N W S: right, up, left, down.
  SKELETONS.forEach((rows, k) => {
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.length === 7), `pose ${k} is 7 wide`);
    const tips = [];
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '9') tips.push([x, y]); }));
    assert.equal(tips.length, 1, `pose ${k} has one fingertip`);
    const [[x, y]] = tips;
    if (k === 0) { assert.equal(x, 6); assert.ok(y >= 3 && y <= 5); }
    if (k === 1) assert.equal(y, 0);
    if (k === 2) { assert.equal(x, 0); assert.ok(y >= 3 && y <= 5); }
    if (k === 3) {
      assert.equal(y, 8);
      // The fingertip stands clear: every neighbour inside the sprite is air but the arm pixel above.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((!dx && !dy) || nx < 0 || nx > 6 || ny < 0 || ny > 9) continue;
          if (dx === 0 && dy === -1) assert.notEqual(rows[ny][nx], '.', 'the arm reaches the fingertip from above');
          else assert.equal(rows[ny][nx], '.', `pixel (${nx}, ${ny}) beside the fingertip`);
        }
      }
    }
  });
});
