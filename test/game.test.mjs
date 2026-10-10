import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW, NCELL, cellNeighbor, DX } from '../src/world/board.mjs';
import { boardMask, MASK_W, MASK_H } from '../src/game/mask.mjs';
import {
  createSim, step, feet, torchRadius, nodeXY, BURN_S, EMBER_S, TICK,
} from '../src/game/sim.mjs';
import { runScript } from '../src/game/autopilot.mjs';
import { artSets } from '../src/game/art.mjs';

const world = createWorld('00000000');

function sampleBoards() {
  const out = [];
  for (let b = -1; b <= 1; b++) {
    for (let i = 0; i < 24; i++) {
      const bd = world.board(i % 6, 4 * b + Math.floor(i / 6));
      if (bd.links) out.push(bd);
    }
  }
  return out;
}

// Zone of a cell: its room plus the floor slab beneath it, in y-up pixels.
function zoneOwner() {
  const owner = new Int16Array(MASK_W * MASK_H).fill(-1);
  for (let c = 0; c < NCELL; c++) {
    const X = (c % BW) * 48, Y = Math.floor(c / BW) * 48;
    for (let y = Math.max(0, Y - 8); y < Y + 40; y++) {
      for (let x = X + 8; x < X + 40; x++) owner[(MASK_H - 1 - y) * MASK_W + x] = c;
    }
  }
  return owner;
}

/** Air path from zone a to zone b that enters no other cell's zone. */
function joined(mask, owner, a, b) {
  const ax = (a % BW) * 48, ay = Math.floor(a / BW) * 48, bx = (b % BW) * 48, by = Math.floor(b / BW) * 48;
  const x0 = Math.max(0, Math.min(ax, bx) - 16), x1 = Math.min(MASK_W, Math.max(ax, bx) + 64);
  const y0 = Math.max(0, Math.min(ay, by) - 16), y1 = Math.min(MASK_H, Math.max(ay, by) + 64);
  const seen = new Uint8Array(MASK_W * MASK_H);
  const q = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (MASK_H - 1 - y) * MASK_W + x;
      if (owner[k] === a && !mask[k]) { seen[k] = 1; q.push(k); }
    }
  }
  for (let h = 0; h < q.length; h++) {
    const k = q[h], x = k % MASK_W, row = (k / MASK_W) | 0, y = MASK_H - 1 - row;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
      const n = (MASK_H - 1 - ny) * MASK_W + nx;
      if (seen[n] || mask[n]) continue;
      if (owner[n] === b) return true;
      if (owner[n] >= 0 && owner[n] !== a) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  return false;
}

test('the rendered maze joins two cells exactly when the tree links them', () => {
  const owner = zoneOwner();
  let pairs = 0, links = 0;
  for (const bd of sampleBoards()) {
    const mask = boardMask(bd);
    for (let c = 0; c < NCELL; c++) {
      for (const d of [0, 1, 4, 5]) {
        const n = cellNeighbor(c, d);
        if (n < 0) continue;
        const linked = !!(bd.links[c] & (1 << d));
        pairs++;
        if (linked) links++;
        assert.equal(joined(mask, owner, c, n), linked, `board (${bd.x},${bd.y}) cells ${c}-${n} dir ${d}`);
      }
    }
  }
  assert.ok(pairs > 10000 && links > 1000);
});

test('board edges open only at doors', () => {
  for (const bd of sampleBoards()) {
    const mask = boardMask(bd);
    const open = (x, y) => !mask[(MASK_H - 1 - y) * MASK_W + x];
    const doorAt = (dir, pos) => bd.doors.some((dr) => {
      if (dr.dir !== dir) return false;
      const cx = dr.cell % BW, cy = Math.floor(dr.cell / BW);
      return dir === 0 || dir === 2 ? pos >= cy * 48 + 8 && pos < cy * 48 + 40 : pos >= cx * 48 + 16 && pos < cx * 48 + 32;
    });
    for (let y = 0; y < MASK_H; y++) {
      if (open(0, y)) assert.ok(doorAt(2, y), `board (${bd.x},${bd.y}) west edge open at y ${y}`);
      if (open(MASK_W - 1, y)) assert.ok(doorAt(0, y), `board (${bd.x},${bd.y}) east edge open at y ${y}`);
    }
    for (let x = 0; x < MASK_W; x++) {
      if (open(x, 0)) assert.ok(doorAt(3, x), `board (${bd.x},${bd.y}) floor open at x ${x}`);
      if (open(x, MASK_H - 1)) assert.ok(doorAt(1, x), `board (${bd.x},${bd.y}) ceiling open at x ${x}`);
    }
    for (const dr of bd.doors) {
      const cx = dr.cell % BW, cy = Math.floor(dr.cell / BW);
      const probe = [[MASK_W - 1, cy * 48 + 24], [cx * 48 + 24, MASK_H - 1], [0, cy * 48 + 24], [cx * 48 + 24, 0]][dr.dir];
      assert.ok(open(...probe), `door ${dr.dir} of board (${bd.x},${bd.y}) is open`);
    }
  }
});

/** A cell on `bd` whose links in direction d chain `n` times. */
function findChain(bd, d, n) {
  for (let c = 0; c < NCELL; c++) {
    let k = c, ok = true;
    for (let i = 0; i < n && ok; i++) {
      if (!(bd.links[k] & (1 << d))) ok = false;
      else k = cellNeighbor(k, d);
    }
    if (ok) return c;
  }
  return -1;
}

function simAt(d, n) {
  for (const bd of sampleBoards()) {
    const c = findChain(bd, d, n);
    if (c >= 0) return createSim(world, { board: bd, cell: c });
  }
  throw new Error(`no chain of ${n} links in direction ${d}`);
}

function run(s, ticks, h, v) {
  for (let i = 0; i < ticks; i++) step(s, h, v);
}

test('the explorer runs at 96 px/s', () => {
  const s = simAt(0, 3);
  const [x0, y0] = feet(s);
  run(s, 60, 1, 0);
  const [x1, y1] = feet(s);
  assert.ok(Math.abs(x1 - x0 - 96) < 1e-6, `moved ${x1 - x0}`);
  assert.equal(y1, y0);
});

test('the explorer climbs ladders at 48 px/s', () => {
  const s = simAt(1, 2);
  const [x0, y0] = feet(s);
  run(s, 60, 0, 1);
  const [x1, y1] = feet(s);
  assert.ok(Math.abs(y1 - y0 - 48) < 1e-6, `climbed ${y1 - y0}`);
  assert.equal(x1, x0);
  assert.equal(s.stats.ladderUp, 1);
});

test('the explorer walks galleries at 72 px/s along the slope', () => {
  for (const d of [4, 5]) {
    const s = simAt(d, 2);
    const [x0, y0] = feet(s);
    run(s, 60, DX[d], 1);
    const [x1, y1] = feet(s);
    assert.ok(Math.abs(Math.hypot(x1 - x0, y1 - y0) - 72) < 1e-6, `walked ${Math.hypot(x1 - x0, y1 - y0)}`);
    assert.ok(Math.abs((x1 - x0) * DX[d] - (y1 - y0)) < 1e-6, 'slope is 45 degrees');
  }
});

test('the explorer never leaves a cell except along a link or door', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
  const t = world.tree(0);
  const s = createSim(world, world.resumePoint(t.entryX, 0));
  let h = 0, v = 0, prev = [s.bd, s.cell], moves = 0;
  for (let i = 0; i < 20000; i++) {
    if (i % 20 === 0) { h = (rnd() % 3) - 1; v = (rnd() % 3) - 1; }
    step(s, h, v);
    s.burn = BURN_S;
    if (s.bd !== prev[0] || s.cell !== prev[1]) {
      let ok = false;
      for (let d = 0; d < 8; d++) {
        const n = world.step(prev[0], prev[1], d);
        if (n && n.board === s.bd && n.cell === s.cell) ok = true;
      }
      assert.ok(ok, `jump from (${prev[0].x},${prev[0].y}):${prev[1]} to (${s.bd.x},${s.bd.y}):${s.cell}`);
      prev = [s.bd, s.cell];
      moves++;
    }
  }
  assert.ok(moves > 100, `only ${moves} moves`);
});

test('torch radius falls from 96 px to 24 px at 10% burn, then an 8 px ember', () => {
  assert.equal(torchRadius(BURN_S), 96);
  assert.equal(torchRadius(BURN_S * 0.1), 24);
  assert.equal(torchRadius(BURN_S * 0.05), 24);
  assert.ok(Math.abs(torchRadius(BURN_S * 0.55) - 60) < 1e-9);
  assert.equal(torchRadius(0), 8);
});

test('a torch burns 300 s, gutters to a 10 s ember, then ends the run', () => {
  const bd = sampleBoards().find((b) => world.flamesAt(b.x, b.y).length === 0);
  const s = createSim(world, { board: bd, cell: 0 });
  run(s, Math.round(BURN_S / TICK) - 1, 0, 0);
  assert.ok(s.burn > 0 && s.state === 'play');
  step(s, 0, 0);
  assert.equal(s.burn, 0);
  assert.ok(s.events.includes('ember'));
  run(s, Math.round(EMBER_S / TICK) - 2, 0, 0);
  assert.equal(s.state, 'play');
  run(s, 3, 0, 0);
  assert.equal(s.state, 'over');
});

test('standing in a flame keeps the torch full and the run alive', () => {
  const f = world.bandFlames(0).chain[0];
  const s = createSim(world, { board: world.board(f.x, f.y), cell: f.cell });
  run(s, Math.round(330 / TICK), 0, 0);
  assert.equal(s.burn, BURN_S);
  assert.equal(s.ember, 0);
  assert.equal(s.state, 'play');
  run(s, Math.round(600 / TICK), 0, 0);
  assert.equal(s.burn, BURN_S);
  assert.equal(s.state, 'play');
  assert.equal(s.stats.flames, 1);
});

test('touching a flame during the ember relights the torch to full', () => {
  for (const bd of sampleBoards()) {
    for (const cell of world.flamesAt(bd.x, bd.y)) {
      for (const d of [0, 2]) {
        const from = cellNeighbor(cell, d ^ 2);
        if (from < 0 || !(bd.links[from] & (1 << d))) continue;
        const s = createSim(world, { board: bd, cell: from });
        s.burn = 0;
        s.ember = EMBER_S;
        run(s, 40, DX[d], 0);
        assert.equal(s.burn > BURN_S - 1, true);
        assert.equal(s.stats.flames, 1);
        const [fx] = nodeXY(bd, cell);
        assert.ok(Math.abs(feet(s)[0] - fx) <= 24);
        return;
      }
    }
  }
  assert.fail('no flame reachable by corridor in the sample');
});

test('the self-test script runs a corridor, climbs, crosses a seam and touches a flame', () => {
  const a = runScript(createWorld('00000000'));
  assert.equal(a.reason, null);
  const b = runScript(createWorld('00000000'));
  assert.deepEqual(b.sim.stats, a.sim.stats);
  assert.ok(a.sim.stats.corridor >= 1 && a.sim.stats.ladderUp >= 1 && a.sim.stats.seams >= 1 && a.sim.stats.flames >= 1);
});

test('art strings keep one width per sprite and use palette characters', () => {
  for (const [name, list] of Object.entries(artSets())) {
    for (const rows of list) {
      for (const r of rows) {
        assert.equal(r.length, rows[0].length, `${name}: ${JSON.stringify(r)}`);
        assert.match(r, name === 'font' ? /^[#.]+$/ : /^[0-9a-v.]+$/, name);
      }
    }
  }
});

