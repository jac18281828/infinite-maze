import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, boardCoords, tombOf } from '../src/world/world.mjs';
import { NCELL, BW, BH } from '../src/world/board.mjs';
import { createSim, step, inputEdges, createTrail, recordStood, BURN_S } from '../src/game/sim.mjs';
import { createAutopilot, SELFTEST_CODE, SELFTEST_TICKS } from '../src/game/autopilot.mjs';
import { frameOf, panFrame, sameFrame, mapModel, mapCells } from '../src/game/map.mjs';
import { DIFFICULTY } from '../src/world/band.mjs';

const EMPTY = { lines: [], stubs: [], outlines: [], flames: [], explorer: null };

const key = (bd, cell) => `${bd.x},${bd.y}:${cell}`;
const fkey = (f) => `${f.u},${f.v}`;
const inTomb = (x, y, f) => sameFrame(tombOf(x, y), f);

/** Cells stood on and links walked, read from nothing but each tick's (bd, cell). */
function watcher(world, s) {
  const stood = new Set([key(s.bd, s.cell)]), walked = new Set();
  let prev = [s.bd, s.cell];
  return {
    stood,
    walked,
    observe() {
      if (s.bd === prev[0] && s.cell === prev[1]) return;
      const ds = [];
      for (let d = 0; d < 8; d++) {
        const n = world.step(prev[0], prev[1], d);
        if (n && n.board === s.bd && n.cell === s.cell) ds.push(d);
      }
      assert.equal(ds.length, 1, `one link joins (${prev[0].x},${prev[0].y}):${prev[1]} to (${s.bd.x},${s.bd.y}):${s.cell}`);
      walked.add(`${key(prev[0], prev[1])}:${ds[0]}`);
      walked.add(`${key(s.bd, s.cell)}:${ds[0] ^ 2}`);
      stood.add(key(s.bd, s.cell));
      prev = [s.bd, s.cell];
    },
  };
}

const frameCell = (bd, cell, f) => [(bd.x - 6 * f.u) * BW + (cell % BW), (bd.y - 4 * f.v) * BH + ((cell / BW) | 0)];

/** What tomb f must show, checked over every cell, link and door of its boards. */
function expectedSet(world, w, f, at) {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const { x, y } = boardCoords(f.u, f.v, i);
    const bd = world.board(x, y);
    if (!bd.links) continue;
    let entered = false;
    for (let cell = 0; cell < NCELL; cell++) {
      if (!w.stood.has(key(bd, cell))) continue;
      entered = true;
      const [col, row] = frameCell(bd, cell, f);
      if (world.flamesAt(bd.x, bd.y).includes(cell)) out.push(`flame ${col},${row}`);
      for (let d = 0; d < 8; d++) {
        const to = world.step(bd, cell, d);
        if (!to) continue;
        if (!w.walked.has(`${key(bd, cell)}:${d}`)) { out.push(`stub ${col},${row},${d}`); continue; }
        if (d < 4 && !(bd.links[cell] & (1 << d))) out.push(`gap ${col},${row},${d}`);
        if ([0, 1, 4, 5].includes(d) && inTomb(to.board.x, to.board.y, f)) out.push(`line ${col},${row},${d}`);
      }
    }
    if (entered) out.push(`outline ${frameCell(bd, 0, f).join(',')}`);
  }
  if (at && inTomb(at.bd.x, at.bd.y, f)) out.push(`explorer ${frameCell(at.bd, at.cell, f).join(',')}`);
  return out.sort();
}

function flat(m) {
  return [
    ...m.lines.map((l) => `line ${l.col},${l.row},${l.d}`),
    ...m.stubs.map((l) => `stub ${l.col},${l.row},${l.d}`),
    ...m.outlines.flatMap((o) => [`outline ${o.col},${o.row}`, ...o.gaps.map((g) => `gap ${g.col},${g.row},${g.d}`)]),
    ...m.flames.map((f) => `flame ${f.col},${f.row}`),
    ...(m.explorer ? [`explorer ${m.explorer.col},${m.explorer.row}`] : []),
  ].sort();
}

/** Checks every tomb holding a stood cell, and the tombs around them, against the watched run. */
function checkTombs(world, s, w, tally) {
  const tombs = new Set();
  for (const k of w.stood) {
    const [x, y] = k.split(':')[0].split(',').map(Number);
    tombs.add(fkey(tombOf(x, y)));
  }
  const fs = [...tombs].map((k) => k.split(',').map(Number));
  const u0 = Math.min(...fs.map((f) => f[0])), u1 = Math.max(...fs.map((f) => f[0]));
  const v0 = Math.min(...fs.map((f) => f[1])), v1 = Math.max(...fs.map((f) => f[1]));
  for (let v = v0 - 1; v <= v1 + 1; v++) {
    for (let u = u0 - 1; u <= u1 + 1; u++) {
      const f = { u, v }, at = { bd: s.bd, cell: s.cell };
      const got = flat(mapModel(world, s.trail, f, at));
      assert.deepEqual(got, expectedSet(world, w, f, at), `tomb ${fkey(f)}`);
      assert.equal(new Set(got).size, got.length, `tomb ${fkey(f)} lists nothing twice`);
      if (!tombs.has(fkey(f))) assert.deepEqual(mapModel(world, s.trail, f, at), EMPTY, `tomb ${fkey(f)} holds no stood cell`);
      for (const e of got) tally[e.split(' ')[0]] = (tally[e.split(' ')[0]] || 0) + 1;
    }
  }
}

/** Frame cell (col, row) of tomb f back to its board and cell. */
function cellOf(world, f, col, row) {
  const bd = world.board(6 * f.u + Math.floor(col / BW), 4 * f.v + Math.floor(row / BH));
  return [bd, (row % BH) * BW + (col % BW)];
}

function checkNamedCells(world, m, f) {
  for (const o of [...m.lines, ...m.stubs, ...m.outlines.flatMap((q) => q.gaps)]) {
    const [bd, cell] = cellOf(world, f, o.col, o.row);
    assert.ok(world.step(bd, cell, o.d), `(${o.col},${o.row}) holds direction ${o.d}`);
  }
}

const noteTally = (tally) => {
  for (const k of ['line', 'stub', 'outline', 'gap', 'flame', 'explorer']) assert.ok(tally[k] > 0, `the runs exercise ${k}`);
};

test('the map shows exactly the walked links, stood openings, entered boards and their flames', () => {
  const world = createWorld(SELFTEST_CODE);
  const tally = {};
  const chain = world.tombFlames(0, 0).chains[0];
  // The self-test script, tick by tick, as runScript drives it.
  {
    const s = createSim(world, world.startPoint());
    const w = watcher(world, s);
    const drive = createAutopilot(world, chain);
    let ph = 0, pv = 0;
    for (let i = 0; i < SELFTEST_TICKS; i++) {
      const [h, v, jump] = drive(s);
      step(s, h, v, jump, inputEdges(ph, pv, h, v));
      ph = h;
      pv = v;
      w.observe();
    }
    assert.ok(w.walked.size > 100, `only ${w.walked.size} walked ends`);
    checkTombs(world, s, w, tally);
  }
  // The script on through the downstream tomb's chain from the entry it reaches.
  {
    const end = chain.at(-1);
    const next = tombOf(end.x, end.y);
    const t = world.tomb(next.u, next.v);
    const j = t.entries.findIndex((i) => { const b = boardCoords(next.u, next.v, i); return b.x === end.x && b.y === end.y; });
    const s = createSim(world, world.startPoint());
    const w = watcher(world, s);
    const drive = createAutopilot(world, [...chain, ...world.tombFlames(next.u, next.v).chains[j]]);
    let ph = 0, pv = 0, left = false;
    for (let i = 0; i < 40000; i++) {
      const [h, v, jump] = drive(s);
      step(s, h, v, jump, inputEdges(ph, pv, h, v));
      ph = h;
      pv = v;
      s.burn = BURN_S;
      w.observe();
      if (s.bd.u !== 0 || s.bd.v !== 0) left = true;
    }
    assert.ok(left, 'the script leaves tomb (0, 0)');
    assert.ok(s.solved.has('0,0'), 'the script solves tomb (0, 0)');
    checkTombs(world, s, w, tally);
  }
  // Seeded random input, as the fuzz test drives it.
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
  const w2 = createWorld('000001C3');
  for (const [u, v] of [[-1, -1], [0, 0], [1, 1]]) {
    const e = boardCoords(u, v, w2.tomb(u, v).entries[0]);
    const s = createSim(w2, w2.resumePoint(e.x, e.y));
    const w = watcher(w2, s);
    let h = 0, vv = 0, ph = 0, pv = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { h = (rnd() % 3) - 1; vv = (rnd() % 3) - 1; }
      step(s, h, vv, rnd() % 12 === 0, inputEdges(ph, pv, h, vv));
      ph = h;
      pv = vv;
      s.burn = BURN_S;
      w.observe();
    }
    checkTombs(w2, s, w, tally);
    checkNamedCells(w2, mapModel(w2, s.trail, frameOf(s.bd), { bd: s.bd, cell: s.cell }), frameOf(s.bd));
  }
  noteTally(tally);
  assert.ok(tally.flame > 0 && tally.gap > 0);
});

test('every cell the model names holds a link or door, and a flame sits on a stood cell', () => {
  const world = createWorld(SELFTEST_CODE);
  const s = createSim(world, world.startPoint());
  const drive = createAutopilot(world, world.tombFlames(0, 0).chains[0]);
  let ph = 0, pv = 0;
  for (let i = 0; i < SELFTEST_TICKS; i++) {
    const [h, v, jump] = drive(s);
    step(s, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
  }
  const f = { u: 0, v: 0 };
  const m = mapModel(world, s.trail, f, { bd: s.bd, cell: s.cell });
  assert.ok(m.lines.length > 20 && m.stubs.length > 5 && m.outlines.length >= 2 && m.flames.length >= 1);
  checkNamedCells(world, m, f);
});

test('frameOf floors board coordinates into tombs, negatives included', () => {
  assert.deepEqual(frameOf({ x: 0, y: 0 }), { u: 0, v: 0 });
  assert.deepEqual(frameOf({ x: 5, y: 3 }), { u: 0, v: 0 });
  assert.deepEqual(frameOf({ x: 6, y: 4 }), { u: 1, v: 1 });
  assert.deepEqual(frameOf({ x: -1, y: -1 }), { u: -1, v: -1 });
  assert.deepEqual(frameOf({ x: -6, y: -4 }), { u: -1, v: -1 });
  assert.deepEqual(frameOf({ x: -7, y: -5 }), { u: -2, v: -2 });
});

test('panFrame moves one tomb in each arrow\'s direction', () => {
  assert.deepEqual(panFrame({ u: 0, v: 0 }, 'u'), { u: 0, v: 1 });
  assert.deepEqual(panFrame({ u: 0, v: 0 }, 'd'), { u: 0, v: -1 });
  assert.deepEqual(panFrame({ u: -3, v: 2 }, 'l'), { u: -4, v: 2 });
  assert.deepEqual(panFrame({ u: -3, v: 2 }, 'r'), { u: -2, v: 2 });
  assert.ok(sameFrame({ u: 1, v: -1 }, { u: 1, v: -1 }) && !sameFrame({ u: 1, v: -1 }, { u: -1, v: 1 }));
});

test('a trail with stood cells in two tombs fills each frame with its own tomb only', () => {
  const world = createWorld(SELFTEST_CODE);
  const trail = createTrail();
  const a = world.startPoint();
  const e = boardCoords(-1, 0, world.tomb(-1, 0).entries[0]);
  const b = world.resumePoint(e.x, e.y);
  recordStood(trail, a.board, a.cell);
  recordStood(trail, b.board, b.cell);
  const at = { bd: a.board, cell: a.cell };
  const fa = { u: 0, v: 0 }, fb = { u: -1, v: 0 };
  const m0 = mapModel(world, trail, fa, at), m1 = mapModel(world, trail, fb, at);
  assert.deepEqual(flat(m0), expectedSet(world, { stood: new Set([key(a.board, a.cell)]), walked: new Set() }, fa, at));
  assert.deepEqual(flat(m1), expectedSet(world, { stood: new Set([key(b.board, b.cell)]), walked: new Set() }, fb, at));
  assert.equal(m0.outlines.length, 1);
  assert.equal(m1.outlines.length, 1);
  assert.ok(m0.explorer && m1.explorer === null);
  for (const f of [{ u: 1, v: 0 }, { u: 0, v: 1 }, { u: -1, v: -1 }, { u: -2, v: 0 }]) assert.deepEqual(mapModel(world, trail, f, at), EMPTY);
  for (const [m, f] of [[m0, fa], [m1, fb]]) {
    for (const o of [...m.stubs, ...m.outlines]) assert.ok(o.col >= 0 && o.col < 72 && o.row >= 0 && o.row < 28, `tomb ${fkey(f)} stays in frame`);
  }
});

test('a fresh run frames a map of its start cell alone', () => {
  const world = createWorld(SELFTEST_CODE);
  const s = createSim(world, world.startPoint());
  const m = mapModel(world, s.trail, frameOf(s.bd), { bd: s.bd, cell: s.cell });
  assert.deepEqual(m.lines, []);
  assert.ok(m.flames.length <= 1);
  assert.equal(m.outlines.length, 1);
  assert.deepEqual(m.outlines[0].gaps, []);
  assert.ok(m.stubs.length >= 1);
});

test('an EASY frame is its 3x2 tomb: 36x14 cells, bands of 2 rows', () => {
  assert.deepEqual(mapCells(DIFFICULTY.easy), { cols: 36, rows: 14 });
  assert.deepEqual(mapCells(DIFFICULTY.medium), { cols: 48, rows: 21 });
  assert.deepEqual(mapCells(DIFFICULTY.hard), { cols: 72, rows: 28 });
  assert.equal(frameOf({ y: 3 }, DIFFICULTY.easy), 1);
  assert.equal(frameOf({ y: -1 }, DIFFICULTY.easy), -1);
  const world = createWorld(SELFTEST_CODE, { difficulty: 'easy' });
  const s = createSim(world, world.resumePoint(world.tree(1).entryX, 2));
  const w = watcher(world, s);
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
  let h = 0, v = 0, ph = 0, pv = 0;
  for (let i = 0; i < 3000; i++) {
    if (i % 20 === 0) { h = (rnd() % 3) - 1; v = (rnd() % 3) - 1; }
    step(s, h, v, rnd() % 12 === 0, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    s.burn = BURN_S;
    w.observe();
  }
  const at = { bd: s.bd, cell: s.cell };
  assert.equal(frameOf(s.bd, world.size), s.bd.band);
  // Every band the trail entered, the start's band 1 among them.
  const bands = new Set([...s.trail.values()].map((t) => frameOf(t, world.size)));
  assert.ok(bands.has(1));
  for (const b of bands) {
    const m = mapModel(world, s.trail, b, at);
    assert.ok(m.outlines.length >= 1, `band ${b} outlines its entered boards`);
    for (const e of [...m.lines, ...m.stubs, ...m.outlines, ...m.flames, ...(m.explorer ? [m.explorer] : [])]) {
      assert.ok(e.col >= 0 && e.col < 36 && e.row >= 0 && e.row < 14, `band ${b}: (${e.col},${e.row}) stays in the EASY frame`);
    }
  }
  // The model's rows count from the tomb's floor at row 2b.
  const m = mapModel(world, s.trail, s.bd.band, at);
  assert.equal(m.explorer.row, (s.bd.y - 2 * s.bd.band) * BH + Math.floor(s.cell / BW));
});
