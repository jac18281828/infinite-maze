import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, cellPath } from '../src/world/world.mjs';
import { NCELL } from '../src/world/board.mjs';
import { BDX, BDY, DIFFICULTIES } from '../src/world/band.mjs';
import { u32 } from '../src/world/hash.mjs';
import { windBranches, windDir } from '../src/world/wind.mjs';
import { worlds, sample, CODE } from './sample.mjs';

// The oracle holds its own copy of the rule, never the module's constants.
const passes = (world, x, y, cell, n) => u32(world.H('wind', x, y, cell)) % 64 < Math.min(n, 18);
const carved = (bd, c) => bd.links[c] !== 0 || bd.doorMask[c] !== 0;
const routes = (d, v1) => sample(d, v1).filter((bd) => bd.kind === 'route');

/** The way on of route board `bd`, derived from the in-cells the spec names. */
function wayCells(world, bd) {
  const o = bd.doors.find((d) => d.dir === bd.bDir).cell;
  const ins = [];
  if (bd.aDir === -1) ins.push(bd.a);
  for (const door of bd.doors) {
    const far = world.board(bd.x + BDX[door.dir], bd.y + BDY[door.dir]);
    if (far.kind === 'route' && far.bDir === (door.dir ^ 2)) ins.push(door.cell);
  }
  const on = new Set([o]);
  for (const c of ins) for (const k of cellPath(bd.links, c, o).cells) on.add(k);
  return on;
}

/** Cells [board, cell] of the branch whose first cell is `first`, never entering `on`. */
function flood(world, bd, on, first) {
  const key = (b, c) => `${b.p}:${c}`;
  const seen = new Set([key(first.board, first.cell)]);
  const out = [[first.board, first.cell]];
  for (let h = 0; h < out.length; h++) {
    const [b, c] = out[h];
    for (let d = 0; d < 8; d++) {
      const s = world.step(b, c, d);
      if (!s || (s.board === bd && on.has(s.cell)) || seen.has(key(s.board, s.cell))) continue;
      seen.add(key(s.board, s.cell));
      out.push([s.board, s.cell]);
    }
  }
  return out;
}

/** The test's own branches of `bd`: the listed ones with their cells. */
function branchesOf(world, bd) {
  const on = wayCells(world, bd);
  return windBranches(world, bd).map((br) => {
    const first = world.step(bd, br.junction, br.dir);
    return { br, cells: flood(world, bd, on, first), first };
  });
}

test('every carved cell of a tree board lies on the way on or in exactly one branch, and n counts the branch\'s cells', () => {
  for (const level of DIFFICULTIES) {
    const world = worlds[level];
    const owner = new Map();
    let spanning = 0;
    for (const bd of routes(level, 5)) {
      const on = wayCells(world, bd);
      for (const { br, cells, first } of branchesOf(world, bd)) {
        assert.ok(on.has(br.junction), 'the junction is a way-on cell');
        assert.equal(first.cell, br.cell);
        assert.equal(first.board.x, br.x);
        assert.equal(first.board.y, br.y);
        assert.equal(br.n, cells.length, `branch ${br.junction}/${br.dir} of board ${bd.x},${bd.y}`);
        if (cells.some(([b]) => b !== bd)) spanning++;
        for (const [b, c] of cells) {
          const k = `${b.p}:${c}`;
          assert.ok(!owner.has(k), `cell ${k} lies in two branches`);
          owner.set(k, br);
          assert.ok(!(b === bd && on.has(c)), 'a branch never enters the way on');
        }
      }
    }
    assert.ok(spanning > 10, `${level}: the sample holds branches across dead-end boards`);
    let way = 0, branch = 0;
    for (const bd of sample(level, 5)) {
      if (bd.kind === 'rock') continue;
      const on = bd.kind === 'route' ? wayCells(world, bd) : new Set();
      for (let c = 0; c < NCELL; c++) {
        if (!carved(bd, c)) continue;
        const isWay = on.has(c), isBranch = owner.has(`${bd.p}:${c}`);
        assert.ok(isWay !== isBranch, `${level}: cell ${c} of board ${bd.x},${bd.y} is ${isWay ? 'in both' : 'in neither'}`);
        if (isWay) way++; else branch++;
      }
    }
    assert.ok(way > 0 && branch > way, `${level}: ${way} way-on and ${branch} branch cells`);
  }
});

test('a branch is windy exactly when its hash passes and none of its route-board cells holds a flame', (t) => {
  for (const level of DIFFICULTIES) {
    const world = worlds[level];
    let held = 0, windy = 0;
    for (const bd of routes(level, 5)) {
      const flames = new Set(world.flamesAt(bd.x, bd.y));
      for (const { br, cells } of branchesOf(world, bd)) {
        const flame = cells.some(([b, c]) => b === bd && flames.has(c));
        const pass = passes(world, br.x, br.y, br.cell, cells.length);
        assert.equal(br.windy, pass && !flame, `${level}: branch ${br.junction}/${br.dir} of board ${bd.x},${bd.y}`);
        if (pass && flame) held++;
        if (br.windy) windy++;
      }
    }
    t.diagnostic(`${level}: ${held} branches pass the hash but hold a flame, ${windy} windy`);
    assert.ok(held >= 1, `${level}: the sample holds a branch that passes the hash and holds a flame`);
    assert.ok(windy > 0);
  }
});

test('a cold world gives the same branches and wind, asked of dead-end boards first', () => {
  for (const level of DIFFICULTIES) {
    const warm = worlds[level], cold = createWorld(CODE, { difficulty: level });
    const boards = sample(level, 5).filter((bd) => bd.kind !== 'rock');
    const coldOf = (bd) => cold.board(bd.x, bd.y);
    for (const bd of boards) {
      if (bd.kind !== 'dead') continue;
      const b = coldOf(bd);
      for (let c = 0; c < NCELL; c++) if (carved(b, c)) windDir(cold, b, c);
    }
    for (const bd of boards.slice().reverse()) {
      const b = coldOf(bd);
      assert.deepEqual(windBranches(cold, b), windBranches(warm, bd), `${level}: board ${bd.x},${bd.y}`);
      for (let c = 0; c < NCELL; c++) {
        if (carved(bd, c)) assert.equal(windDir(cold, b, c), windDir(warm, bd, c), `${level}: board ${bd.x},${bd.y} cell ${c}`);
      }
    }
  }
});

test('from every cell of a windy branch the wind leads out along links and doors to the junction, and is -1 elsewhere', (t) => {
  for (const level of DIFFICULTIES) {
    const world = worlds[level];
    const lit = new Set();
    for (const bd of routes(level, 5)) {
      for (const { br, cells } of branchesOf(world, bd)) {
        if (!br.windy) continue;
        for (const [b, c] of cells) {
          lit.add(`${b.p}:${c}`);
          let at = { board: b, cell: c };
          const path = new Set();
          while (!(at.board === bd && at.cell === br.junction)) {
            const k = `${at.board.p}:${at.cell}`;
            assert.ok(!path.has(k), `${level}: the wind from ${b.x},${b.y} cell ${c} revisits ${k}`);
            path.add(k);
            const d = windDir(world, at.board, at.cell);
            assert.ok(d >= 0 && d <= 7, `${level}: wind ${d} at ${k}`);
            at = world.step(at.board, at.cell, d);
            assert.ok(at, `${level}: the wind from ${k} names no link or door`);
          }
        }
      }
    }
    let silent = 0;
    for (const bd of sample(level, 5)) {
      if (bd.kind === 'rock') continue;
      for (let c = 0; c < NCELL; c++) {
        if (!carved(bd, c) || lit.has(`${bd.p}:${c}`)) continue;
        assert.equal(windDir(world, bd, c), -1, `${level}: board ${bd.x},${bd.y} cell ${c}`);
        silent++;
      }
    }
    assert.ok(silent > lit.size);
    t.diagnostic(`${level}: ${lit.size} windy cells`);
  }
});

test('windy branches are at most 1/5 of branches and cells, and the share falls from dead-end rooms to long stubs to short ones', (t) => {
  // cls holds [windy, all] for the branches that reach a dead-end board, the
  // others of 8+ cells and those under 8.
  for (const level of DIFFICULTIES) {
    const world = worlds[level];
    const cls = [[0, 0], [0, 0], [0, 0]];
    let all = 0, windy = 0, cells = 0, windyCells = 0;
    for (const bd of routes(level, 19)) {
      for (const { br, cells: cs } of branchesOf(world, bd)) {
        const k = cs.some(([b]) => b.kind === 'dead') ? 0 : cs.length >= 8 ? 1 : 2;
        cls[k][1]++;
        all++; cells += cs.length;
        if (br.windy) { cls[k][0]++; windy++; windyCells += cs.length; }
      }
    }
    t.diagnostic(`${level}: ${all} branches, ${windy} windy (${(100 * windy / all).toFixed(1)}%), ${cells} cells, ${windyCells} windy (${(100 * windyCells / cells).toFixed(1)}%), classes ${JSON.stringify(cls)}`);
    assert.ok(windy * 5 <= all && windyCells * 5 <= cells);
    const share = cls.map(([w, n]) => w / n);
    assert.ok(share[0] > share[1] && share[1] > share[2], `${level}: shares ${share}`);
  }
});

test('a dead-end or rock board lists no branches', () => {
  for (const level of DIFFICULTIES) {
    const world = worlds[level];
    let dead = 0;
    for (const bd of sample(level, 3)) {
      if (bd.kind === 'route') continue;
      assert.deepEqual(windBranches(world, bd), []);
      dead += bd.kind === 'dead';
    }
    assert.ok(dead > 0);
  }
});
