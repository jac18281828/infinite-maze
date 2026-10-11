import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { NCELL, BW, BH } from '../src/world/board.mjs';
import { createSim, step, inputEdges, createTrail, recordStood, BURN_S } from '../src/game/sim.mjs';
import { createAutopilot, SELFTEST_CODE, SELFTEST_TICKS } from '../src/game/autopilot.mjs';
import { frameOf, panFrame, mapModel } from '../src/game/map.mjs';

const EMPTY = { lines: [], stubs: [], outlines: [], flames: [], explorer: null };

const key = (bd, cell) => `${bd.x},${bd.y}:${cell}`;
const bandOfY = (y) => Math.floor(y / 4);

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

const frameCell = (bd, cell, b) => [bd.x * BW + (cell % BW), (bd.y - 4 * b) * BH + ((cell / BW) | 0)];

/** What band b must show, checked over every cell, link and door of its boards. */
function expectedSet(world, w, b, at) {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const bd = world.board(i % 6, 4 * b + Math.floor(i / 6));
    if (!bd.links) continue;
    let entered = false;
    for (let cell = 0; cell < NCELL; cell++) {
      if (!w.stood.has(key(bd, cell))) continue;
      entered = true;
      const [col, row] = frameCell(bd, cell, b);
      if (world.flamesAt(bd.x, bd.y).includes(cell)) out.push(`flame ${col},${row}`);
      for (let d = 0; d < 8; d++) {
        const to = world.step(bd, cell, d);
        if (!to) continue;
        if (!w.walked.has(`${key(bd, cell)}:${d}`)) { out.push(`stub ${col},${row},${d}`); continue; }
        if (d < 4 && !(bd.links[cell] & (1 << d))) out.push(`gap ${col},${row},${d}`);
        if ([0, 1, 4, 5].includes(d) && bandOfY(to.board.y) === b) out.push(`line ${col},${row},${d}`);
      }
    }
    if (entered) out.push(`outline ${frameCell(bd, 0, b).join(',')}`);
  }
  if (at && bandOfY(at.bd.y) === b) out.push(`explorer ${frameCell(at.bd, at.cell, b).join(',')}`);
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

/** Checks every band holding a stood cell, and the bands either side of them, against the watched run. */
function checkBands(world, s, w, tally) {
  const bands = new Set();
  for (const k of w.stood) bands.add(bandOfY(+k.split(',')[1].split(':')[0]));
  const lo = Math.min(...bands), hi = Math.max(...bands);
  for (let b = lo - 1; b <= hi + 1; b++) {
    const at = { bd: s.bd, cell: s.cell };
    const got = flat(mapModel(world, s.trail, b, at));
    assert.deepEqual(got, expectedSet(world, w, b, at), `band ${b}`);
    assert.equal(new Set(got).size, got.length, `band ${b} lists nothing twice`);
    if (!bands.has(b)) assert.deepEqual(mapModel(world, s.trail, b, at), EMPTY, `band ${b} holds no stood cell`);
    for (const e of got) tally[e.split(' ')[0]] = (tally[e.split(' ')[0]] || 0) + 1;
  }
}

/** Frame cell (col, row) of band b back to its board and cell. */
function cellOf(world, b, col, row) {
  const bd = world.board(Math.floor(col / BW), 4 * b + Math.floor(row / BH));
  return [bd, (row % BH) * BW + (col % BW)];
}

function checkNamedCells(world, m, b) {
  for (const o of [...m.lines, ...m.stubs, ...m.outlines.flatMap((q) => q.gaps)]) {
    const [bd, cell] = cellOf(world, b, o.col, o.row);
    assert.ok(world.step(bd, cell, o.d), `(${o.col},${o.row}) holds direction ${o.d}`);
  }
}

const noteTally = (tally) => {
  for (const k of ['line', 'stub', 'outline', 'gap', 'flame', 'explorer']) assert.ok(tally[k] > 0, `the runs exercise ${k}`);
};

test('the map shows exactly the walked links, stood openings, entered boards and their flames', () => {
  const world = createWorld(SELFTEST_CODE);
  const tally = {};
  // The self-test script, tick by tick, as runScript drives it.
  {
    const s = createSim(world, world.resumePoint(world.tree(0).entryX, 0));
    const w = watcher(world, s);
    const drive = createAutopilot(world, world.bandFlames(0).chain);
    let ph = 0, pv = 0;
    for (let i = 0; i < SELFTEST_TICKS; i++) {
      const [h, v, jump] = drive(s);
      step(s, h, v, jump, inputEdges(ph, pv, h, v));
      ph = h;
      pv = v;
      w.observe();
    }
    assert.ok(w.walked.size > 100, `only ${w.walked.size} walked ends`);
    checkBands(world, s, w, tally);
  }
  // The script on up through band 1's chain, which crosses the band seam.
  {
    const s = createSim(world, world.resumePoint(world.tree(0).entryX, 0));
    const w = watcher(world, s);
    const drive = createAutopilot(world, [...world.bandFlames(0).chain, ...world.bandFlames(1).chain]);
    let ph = 0, pv = 0, top = 0;
    for (let i = 0; i < 16000; i++) {
      const [h, v, jump] = drive(s);
      step(s, h, v, jump, inputEdges(ph, pv, h, v));
      ph = h;
      pv = v;
      s.burn = BURN_S;
      w.observe();
      top = Math.max(top, s.bd.band);
    }
    assert.ok(top >= 1, 'the script climbs into band 1');
    checkBands(world, s, w, tally);
  }
  // Seeded random input, as the fuzz test drives it.
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
  const w2 = createWorld('000001C3');
  for (let b = -1; b <= 1; b++) {
    const s = createSim(w2, w2.resumePoint(w2.tree(b).entryX, 4 * b));
    const w = watcher(w2, s);
    let h = 0, v = 0, ph = 0, pv = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) { h = (rnd() % 3) - 1; v = (rnd() % 3) - 1; }
      step(s, h, v, rnd() % 12 === 0, inputEdges(ph, pv, h, v));
      ph = h;
      pv = v;
      s.burn = BURN_S;
      w.observe();
    }
    checkBands(w2, s, w, tally);
    checkNamedCells(w2, mapModel(w2, s.trail, s.bd.band, { bd: s.bd, cell: s.cell }), s.bd.band);
  }
  noteTally(tally);
  assert.ok(tally.flame > 0 && tally.gap > 0);
});

test('every cell the model names holds a link or door, and a flame sits on a stood cell', () => {
  const world = createWorld(SELFTEST_CODE);
  const s = createSim(world, world.resumePoint(world.tree(0).entryX, 0));
  const drive = createAutopilot(world, world.bandFlames(0).chain);
  let ph = 0, pv = 0;
  for (let i = 0; i < SELFTEST_TICKS; i++) {
    const [h, v, jump] = drive(s);
    step(s, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
  }
  const m = mapModel(world, s.trail, 0, { bd: s.bd, cell: s.cell });
  assert.ok(m.lines.length > 20 && m.stubs.length > 5 && m.outlines.length >= 2 && m.flames.length >= 1);
  checkNamedCells(world, m, 0);
});

test('frameOf floors board rows into bands, negative rows included', () => {
  assert.equal(frameOf({ y: 0 }), 0);
  assert.equal(frameOf({ y: 3 }), 0);
  assert.equal(frameOf({ y: 4 }), 1);
  assert.equal(frameOf({ y: -1 }), -1);
  assert.equal(frameOf({ y: -4 }), -1);
  assert.equal(frameOf({ y: -5 }), -2);
});

test('panFrame moves one band up or down and holds on left and right', () => {
  assert.equal(panFrame(0, 'u'), 1);
  assert.equal(panFrame(0, 'd'), -1);
  assert.equal(panFrame(-3, 'u'), -2);
  assert.equal(panFrame(2, 'l'), 2);
  assert.equal(panFrame(2, 'r'), 2);
});

test('a trail with stood cells in two bands fills each frame with its own band only', () => {
  const world = createWorld(SELFTEST_CODE);
  const trail = createTrail();
  const a = world.resumePoint(world.tree(0).entryX, 0), b = world.resumePoint(world.tree(-1).entryX, -4);
  recordStood(trail, a.board, a.cell);
  recordStood(trail, b.board, b.cell);
  const at = { bd: a.board, cell: a.cell };
  const m0 = mapModel(world, trail, 0, at), m1 = mapModel(world, trail, -1, at);
  assert.deepEqual(flat(m0), expectedSet(world, { stood: new Set([key(a.board, a.cell)]), walked: new Set() }, 0, at));
  assert.deepEqual(flat(m1), expectedSet(world, { stood: new Set([key(b.board, b.cell)]), walked: new Set() }, -1, at));
  assert.equal(m0.outlines.length, 1);
  assert.equal(m1.outlines.length, 1);
  assert.ok(m0.explorer && m1.explorer === null);
  assert.deepEqual(mapModel(world, trail, 1, at), EMPTY);
  assert.deepEqual(mapModel(world, trail, -2, at), EMPTY);
  for (const [m, band] of [[m0, 0], [m1, -1]]) {
    for (const e of [...m.stubs, ...m.outlines]) assert.ok(e.col >= 0 && e.col < 72 && e.row >= 0 && e.row < 28, `band ${band} stays in frame`);
  }
});

test('a fresh run frames a map of its start cell alone', () => {
  const world = createWorld(SELFTEST_CODE);
  const s = createSim(world, world.resumePoint(world.tree(0).entryX, 0));
  const m = mapModel(world, s.trail, 0, { bd: s.bd, cell: s.cell });
  assert.deepEqual(m.lines, []);
  assert.ok(m.flames.length <= 1);
  assert.equal(m.outlines.length, 1);
  assert.deepEqual(m.outlines[0].gaps, []);
  assert.ok(m.stubs.length >= 1);
});
