import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, boardCoords, cellPath } from '../src/world/world.mjs';
import { DX, DY, NCELL } from '../src/world/board.mjs';
import { BDX, BDY, DIFFICULTIES } from '../src/world/band.mjs';
import { u32 } from '../src/world/hash.mjs';
import { SIGN_MOD, SIGN_THRESHOLD, junctions, signs } from '../src/world/signs.mjs';
import { SIGNS, artSets } from '../src/game/art.mjs';

// The oracle holds its own copy of the rule, never the module's constants.
const MOD = 48;
const THRESHOLD = { easy: 8, medium: 6, hard: 4, ultimate: 3 };
const SHARE = { easy: 1 / 6, medium: 1 / 8, hard: 1 / 12, ultimate: 1 / 16 };
const worlds = Object.fromEntries(DIFFICULTIES.map((d) => [d, createWorld('00000000', { difficulty: d })]));

/** Boards of tombs u -2..2 by v v0..v1 at `level`. */
function boardsOf(level, v0, v1) {
  const w = worlds[level], out = [];
  for (let v = v0; v <= v1; v++) {
    for (let u = -2; u <= 2; u++) {
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

/** The oracle's sign junctions of a route board: cell -> direction. */
function expected(world, bd) {
  const o = outCell(bd), got = new Map();
  for (const c of inCells(world, bd).keys()) {
    const path = cellPath(bd.links, c, o);
    for (let k = 0; k + 1 < path.cells.length; k++) {
      const cell = path.cells[k];
      if (bits(bd.links[cell]) + bits(bd.doorMask[cell]) >= 3) got.set(cell, path.dirs[k]);
    }
  }
  return got;
}

test('the share of sign junctions that carry a sign is 1/6 at EASY, 1/8 at MEDIUM and 1/12 at HARD', () => {
  for (const level of DIFFICULTIES) {
    let junc = 0, carried = 0;
    // EASY's 2x2 tombs need twice the rows to pass 2,000 sign junctions.
    for (const bd of boardsOf(level, 0, level === 'easy' ? 39 : 19)) {
      junc += junctions(worlds[level], bd).length;
      carried += signs(worlds[level], bd).length;
    }
    assert.ok(junc > 2000, `${level}: ${junc} sign junctions`);
    assert.ok(Math.abs(carried / junc - SHARE[level]) <= 0.02, `${level}: ${carried}/${junc}`);
  }
});

test('a sign junction carries a sign exactly when its hash mod 48 is under the level threshold', () => {
  assert.equal(SIGN_MOD, MOD);
  assert.deepEqual(SIGN_THRESHOLD, THRESHOLD);
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    let carried = 0, bare = 0;
    for (const bd of boardsOf(level, 0, 3)) {
      const has = new Set(signs(w, bd).map((s) => s.cell));
      for (const { cell } of junctions(w, bd)) {
        const pass = u32(w.H('sign', bd.x, bd.y, cell)) % MOD < THRESHOLD[level];
        assert.equal(has.has(cell), pass, `${level} board ${bd.p} cell ${cell}`);
        if (pass) carried++; else bare++;
      }
      for (const c of has) assert.ok(junctions(w, bd).some((j) => j.cell === c), 'a sign sits on a junction');
    }
    assert.ok(carried > 20 && bare > 20, `${level}: ${carried} carried, ${bare} bare`);
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

test('every sign sits on a route board and its link leads to the next cell of the path toward the out-door', () => {
  const dirs = new Set();
  let n = 0;
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    for (const bd of boardsOf(level, 0, 19)) {
      for (const { cell, dir } of signs(w, bd)) {
        assert.equal(bd.kind, 'route');
        const next = w.step(bd, cell, dir);
        assert.equal(next.board, bd);
        assert.equal(next.cell, cellPath(bd.links, cell, outCell(bd)).cells[1]);
        dirs.add(dir);
        n++;
      }
    }
  }
  assert.ok(n > 1500);
  assert.equal(dirs.size, 8, 'the sample holds a sign for each direction');
});

test('dead-end boards carry no sign, and the sample holds dead-end cells with three or more ways out', () => {
  let dead = 0, cells = 0;
  for (const level of DIFFICULTIES) {
    const w = worlds[level];
    for (const bd of boardsOf(level, 0, 3)) {
      if (bd.kind !== 'dead') continue;
      dead++;
      assert.deepEqual(junctions(w, bd), []);
      assert.deepEqual(signs(w, bd), []);
      for (let c = 0; c < NCELL; c++) if (bits(bd.links[c]) + bits(bd.doorMask[c]) >= 3) cells++;
    }
  }
  assert.ok(dead > 20 && cells >= 210, `${dead} dead-end boards, ${cells} cells`);
});

test('the eight glyphs differ pairwise, fit 7 x 7 and point their direction', () => {
  assert.equal(SIGNS.length, 8);
  assert.equal(artSets().sign, SIGNS);
  assert.equal(new Set(SIGNS.map((g) => g.join('/'))).size, 8);
  SIGNS.forEach((rows, d) => {
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
