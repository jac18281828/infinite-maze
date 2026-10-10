import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW, NCELL, cellNeighbor, DX } from '../src/world/board.mjs';
import { boardMask, MASK_W, MASK_H } from '../src/game/mask.mjs';
import {
  createSim, step, feet, torchRadius, nodeXY, inputEdges, BURN_S, EMBER_S, TICK, KEY, ROOM_CLEAR, SHAFT_REACH,
  STAIR_REACH,
} from '../src/game/sim.mjs';
import { runScript, SELFTEST_TICKS } from '../src/game/autopilot.mjs';
import { artSets } from '../src/game/art.mjs';

const world = createWorld('00000000');
const UP = [1, 4, 5];
const has = (bd, c, d) => !!world.step(bd, c, d);

/** First cell over bands -3..3 where pred(bd, cell) holds. */
function findCell(pred) {
  for (let b = -3; b <= 3; b++) {
    for (let i = 0; i < 24; i++) {
      const bd = world.board(i % 6, 4 * b + Math.floor(i / 6));
      if (!bd.links) continue;
      for (let c = 0; c < NCELL; c++) if (pred(bd, c)) return { bd, cell: c };
    }
  }
  throw new Error('no cell matches');
}

function simOn({ bd, cell }, off = 0, facing = 1) {
  const s = createSim(world, { board: bd, cell });
  s.off = off;
  s.facing = facing;
  return s;
}

/** Steps `s` with held input (h, v), deriving key edges from the previous input. */
function driver(s) {
  let ph = 0, pv = 0;
  return (h, v, jump = false) => {
    step(s, h, v, jump, inputEdges(ph, pv, h, v));
    ph = h;
    pv = v;
    return s;
  };
}

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
  // Blocks never overlap, so galleries never chain; half a second fits one.
  for (const d of [4, 5]) {
    const s = simAt(d, 1);
    const [x0, y0] = feet(s);
    run(s, 30, DX[d], 1);
    const [x1, y1] = feet(s);
    assert.ok(Math.abs(Math.hypot(x1 - x0, y1 - y0) - 36) < 1e-6, `walked ${Math.hypot(x1 - x0, y1 - y0)}`);
    assert.ok(Math.abs((x1 - x0) * DX[d] - (y1 - y0)) < 1e-6, 'slope is 45 degrees');
  }
});

test('Up takes an up-gallery over a ladder down unless a side points away; Down takes the ladder', () => {
  for (const g of [4, 5]) {
    const at = findCell((bd, c) => has(bd, c, g) && has(bd, c, 3));
    for (const facing of [1, -1]) {
      for (const [h, v, want] of [[0, 1, g], [DX[g], 1, g], [-DX[g], 1, -1], [0, -1, 3]]) {
        const s = simOn(at, 0, facing);
        const go = driver(s);
        let linked = false;
        for (let i = 0; i < 10; i++) linked = go(h, v).mode === 'link' || linked;
        const label = `dir ${g}, facing ${facing}, input (${h}, ${v})`;
        if (want < 0) assert.ok(!linked && s.mode === 'floor', label);
        else assert.ok(s.mode === 'link' && s.link === want, label);
      }
    }
  }
});

test('Up slides from the far side of an up-gallery to its foot, never facing away', () => {
  for (const g of [4, 5]) {
    const at = findCell((bd, c) => has(bd, c, g));
    const s = simOn(at, -11 * DX[g], -DX[g]);
    const go = driver(s);
    let x = feet(s)[0];
    for (let i = 0; i < 20; i++) {
      go(0, 1);
      assert.equal(s.facing, DX[g], `dir ${g}, tick ${i}`);
      assert.ok((feet(s)[0] - x) * DX[g] > 0, `dir ${g}, tick ${i}: moves toward the gallery`);
      x = feet(s)[0];
    }
    assert.ok(s.mode === 'link' && s.link === g && s.prog > 0);
  }
});

test('Up at a ladder from offset +10 engages without turning', () => {
  const at = findCell((bd, c) => has(bd, c, 1) && !has(bd, c, 7));
  for (const facing of [1, -1]) {
    const s = simOn(at, 10, facing);
    const go = driver(s);
    for (let i = 0; i < 12; i++) {
      go(0, 1);
      assert.equal(s.facing, facing, `facing ${facing}, tick ${i}`);
    }
    assert.ok(s.mode === 'link' && s.link === 1 && s.prog > 0);
  }
});

test('an Up tap released 100 ms before reaching a ladder cell takes the ladder', () => {
  // L: a ladder cell; its west corridor neighbour has no up-link.
  const at = findCell((bd, c) => has(bd, c, 1) && bd.links[c] & 4 && UP.every((d) => !has(bd, c - 1, d)));
  const from = { bd: at.bd, cell: at.cell - 1 };
  const probe = simOn(from);
  let reach = 0;
  while (probe.cell !== at.cell && reach < 100) { step(probe, 1, 0); reach++; }
  // A one-tick Up tap, released `before` ticks ahead of the tick that enters L.
  const takes = (before) => {
    const s = simOn(from);
    const go = driver(s);
    const release = reach - 1 - before;
    assert.ok(release >= 1);
    for (let i = 0; i < reach + 30; i++) {
      go(1, i === release - 1 ? 1 : 0);
      if (s.mode === 'link') return s.link === 1 && s.cell === at.cell;
    }
    return false;
  };
  assert.ok(takes(6), 'tap released 100 ms ahead');
  assert.ok(!takes(12), 'tap released 200 ms ahead');
});

test('a Left or Right press turns the explorer at once, even on a ladder', () => {
  const s = simAt(1, 2);
  run(s, 10, 0, 1);
  assert.equal(s.mode, 'link');
  const prog = s.prog;
  step(s, -1, 0, false, { press: KEY.L, release: 0 });
  assert.equal(s.facing, -1);
  step(s, 1, 0, false, { press: KEY.R, release: KEY.L });
  assert.equal(s.facing, 1);
  assert.equal(s.prog, prog);
});

test('a room jump stops the head at the 8 px clearance and lands in about 0.2 s', () => {
  const s = simOn(findCell((bd, c) => UP.every((d) => !has(bd, c, d))));
  const go = driver(s);
  let top = 0, ticks = 0;
  go(0, 0, true);
  while (s.mode === 'air') {
    top = Math.max(top, s.alt);
    go(0, 0);
    ticks++;
  }
  assert.equal(top, ROOM_CLEAR);
  assert.equal(s.mode, 'floor');
  assert.ok(ticks >= 10 && ticks <= 13, `${ticks + 1} ticks of air`);
});

test('under its ladder shaft a jump rises 16 px, and the head stays within the shaft', () => {
  const at = findCell((bd, c) => has(bd, c, 1) && !has(bd, c, 7) && !has(bd, c, 6));
  const s = simOn(at);
  const go = driver(s);
  let top = 0, ticks = 0;
  go(0, 0, true);
  while (s.mode === 'air') {
    top = Math.max(top, s.alt);
    // Halfway up, run sideways: the shaft holds the head until it drops into the room.
    go(ticks >= 6 ? 1 : 0, 0);
    if (s.alt > ROOM_CLEAR) assert.ok(Math.abs(s.off) <= SHAFT_REACH, `off ${s.off} at height ${s.alt}`);
    ticks++;
  }
  assert.ok(Math.abs(top - 16) < 1e-9, `apex ${top}`);
  assert.ok(ticks >= 22 && ticks <= 24, `${ticks + 1} ticks of air`);
});

test('Up in the air under a ladder shaft grabs the ladder at the current height', () => {
  const s = simOn(findCell((bd, c) => has(bd, c, 1)));
  const go = driver(s);
  go(0, 0, true);
  for (let i = 0; i < 5; i++) go(0, 0);
  assert.equal(s.mode, 'air');
  go(0, 1);
  assert.ok(s.mode === 'link' && s.link === 1 && s.prog > 0, `${s.mode} ${s.link} ${s.prog}`);
  assert.equal(s.stats.airGrabs, 1);
});

test('a jump from the cell centre toward an up-gallery lands on its stair, Up never pressed', () => {
  for (const g of [4, 5]) {
    const s = simOn(findCell((bd, c) => has(bd, c, g)), 0, DX[g]);
    const go = driver(s);
    let before = null;
    go(DX[g], 0, true);
    for (let i = 0; i < 30 && s.mode === 'air'; i++) {
      before = s.mode;
      go(DX[g], 0);
    }
    assert.equal(before, 'air');
    assert.ok(s.mode === 'link' && s.link === g && s.prog > 0, `${s.mode} ${s.link} ${s.prog}`);
    assert.equal(s.stats.stairLandings, 1);
  }
});

test('Up held in the air engages an up-gallery within 4 px of its stair', () => {
  for (const g of [4, 5]) {
    const at = findCell((bd, c) => has(bd, c, g));
    // The same running jump from the far side, with and without Up held.
    const trace = (holdUp) => {
      const s = simOn(at, -11 * DX[g], DX[g]);
      const go = driver(s);
      const out = [];
      go(DX[g], 0, true);
      for (let i = 0; i < 30; i++) {
        out.push({ mode: s.mode, gap: s.alt - s.off * DX[g], over: s.off * DX[g] >= 0 });
        if (s.mode !== 'air') break;
        go(DX[g], holdUp ? 1 : 0);
      }
      return out;
    };
    const held = trace(true), free = trace(false);
    const t = held.findIndex((p) => p.mode === 'link');
    assert.ok(t > 0 && held[t - 1].mode === 'air', `dir ${g}: airborne before engaging`);
    // Without Up the arc is still airborne there, its feet 0-4 px over the stair.
    assert.equal(free[t].mode, 'air');
    assert.ok(free[t].over && free[t].gap > 0 && free[t].gap <= STAIR_REACH, `dir ${g}: gap ${free[t].gap}`);
    for (let j = 0; j < t; j++) assert.ok(!free[j].over || free[j].gap > STAIR_REACH, `dir ${g}: window open at ${j}`);
  }
});

test('in the air a down-gallery mouth keeps the explorer out', () => {
  for (const g of [7, 6]) {
    const s = simOn(findCell((bd, c) => has(bd, c, g)), -5 * DX[g], DX[g]);
    const go = driver(s);
    let air = 0;
    go(DX[g], 0, true);
    while (s.mode === 'air') {
      assert.ok(s.off * DX[g] <= 0, `dir ${g}: off ${s.off}`);
      go(DX[g], 0);
      air++;
    }
    assert.ok(air >= 10);
  }
});

test('a jump neither speeds nor slows a run', () => {
  const at = findCell((bd, c) => c % 12 < 10 && bd.links[c] & 1 && bd.links[c + 1] & 1
    && [c, c + 1, c + 2].every((u) => UP.every((d) => !has(bd, u, d))));
  const ran = (jumpAt) => {
    const s = simOn(at);
    const go = driver(s);
    for (let i = 0; i < 40; i++) go(1, 0, i === jumpAt);
    return { x: feet(s)[0], jumps: s.stats.jumps };
  };
  const plain = ran(-1), hop = ran(3);
  assert.equal(hop.jumps, 1);
  assert.ok(Math.abs(hop.x - plain.x) < 1e-9, `${hop.x} vs ${plain.x}`);
});

test('the explorer never leaves a cell except along a link or door', () => {
  // Random arrows and jumps from the entries of 7 bands in each of 4 seeds.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
  let moves = 0, jumps = 0, air = 0, bands = 0;
  for (const code of ['00000000', '000001C3', 'K7Q2M9XA', 'ZZZZZZZZ']) {
    const w = createWorld(code);
    for (let b = -3; b <= 3; b++) {
      bands++;
      const s = createSim(w, w.resumePoint(w.tree(b).entryX, 4 * b));
      let h = 0, v = 0, ph = 0, pv = 0, prev = [s.bd, s.cell];
      for (let i = 0; i < 3000; i++) {
        if (i % 20 === 0) { h = (rnd() % 3) - 1; v = (rnd() % 3) - 1; }
        step(s, h, v, rnd() % 12 === 0, inputEdges(ph, pv, h, v));
        ph = h;
        pv = v;
        s.burn = BURN_S;
        if (s.bd === prev[0] && s.cell === prev[1]) continue;
        let ok = false;
        for (let d = 0; d < 8; d++) {
          const n = w.step(prev[0], prev[1], d);
          if (n && n.board === s.bd && n.cell === s.cell) ok = true;
        }
        assert.ok(ok, `${code}: from (${prev[0].x},${prev[0].y}):${prev[1]} to (${s.bd.x},${s.bd.y}):${s.cell} in ${s.mode}`);
        prev = [s.bd, s.cell];
        moves++;
      }
      jumps += s.stats.jumps;
      air += s.stats.airGrabs + s.stats.stairLandings;
    }
  }
  assert.ok(bands >= 25);
  assert.ok(moves > 300, `only ${moves} moves`);
  assert.ok(jumps > 500, `only ${jumps} jumps`);
  assert.ok(air > 30, `only ${air} air grabs and stair landings`);
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

test('the self-test script runs a corridor, climbs, crosses a seam, touches a flame, jumps and grabs', () => {
  const a = runScript(createWorld('00000000'));
  assert.equal(a.reason, null);
  const b = runScript(createWorld('00000000'));
  assert.deepEqual(b.sim.stats, a.sim.stats);
  const st = a.sim.stats;
  assert.ok(st.corridor >= 1 && st.ladderUp >= 1 && st.seams >= 1 && st.flames >= 1);
  assert.ok(st.jumps >= 1 && st.airGrabs + st.stairLandings >= 1);
});

test('the self-test script fails when the autopilot omits jumps or air grabs', () => {
  assert.equal(runScript(createWorld('00000000'), SELFTEST_TICKS, { jumps: false }).reason, 'no jump');
  assert.equal(runScript(createWorld('00000000'), SELFTEST_TICKS, { grabs: false }).reason, 'no air grab or stair landing');
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

