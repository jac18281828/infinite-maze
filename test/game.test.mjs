import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/world.mjs';
import { BW, NCELL, cellNeighbor, DX, DY } from '../src/world/board.mjs';
import { boardMask, rockAt, MASK_W, MASK_H } from '../src/game/mask.mjs';
import {
  createSim, step, feet, torchRadius, nodeXY, inputEdges, BURN_S, EMBER_S, TICK, KEY, ROOM_CLEAR, SHAFT_REACH,
  STAIR_REACH, RUN_SPEED, GALLERY_SPEED, GRAVITY, BOARD_W, BOARD_H, pose,
} from '../src/game/sim.mjs';
import { runScript, SELFTEST_TICKS } from '../src/game/autopilot.mjs';
import { artSets, EXPLORER, torchTip } from '../src/game/art.mjs';

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

test('an Up tap released 9 ticks before the tick that enters a ladder cell takes the ladder, 10 ticks misses', () => {
  // L: a ladder cell; its west corridor neighbour has no up-link.
  const at = findCell((bd, c) => has(bd, c, 1) && bd.links[c] & 4 && UP.every((d) => !has(bd, c - 1, d)));
  const from = { bd: at.bd, cell: at.cell - 1 };
  const probe = simOn(from);
  let reach = 0;
  while (probe.cell !== at.cell && reach < 100) { step(probe, 1, 0); reach++; }
  // Step reach - 1 enters L. An Up tap released at step reach - 1 - before,
  // held the tick before (`held`) or pressed and released within that step.
  const takes = (before, held) => {
    const s = simOn(from);
    const release = reach - 1 - before;
    assert.ok(release >= 1);
    for (let i = 0; i < reach + 30; i++) {
      const up = held && i === release - 1;
      const press = (i === 0 ? KEY.R : 0) | (up || (!held && i === release) ? KEY.U : 0);
      const lift = i === release ? KEY.U : 0;
      step(s, 1, up ? 1 : 0, false, { press, release: lift });
      if (s.mode === 'link') return s.link === 1 && s.cell === at.cell;
    }
    return false;
  };
  for (const held of [true, false]) {
    for (let g = 0; g <= 9; g++) assert.ok(takes(g, held), `held ${held}: tap released ${g} ticks ahead`);
    assert.ok(!takes(10, held), `held ${held}: tap released 10 ticks ahead`);
  }
});

test('a Left or Right press turns the explorer at once and, on a ladder, dismounts it', () => {
  const s = simAt(1, 2);
  run(s, 10, 0, 1);
  assert.equal(s.mode, 'link');
  const { cell } = s, prog = s.prog;
  step(s, -1, 0, false, { press: KEY.L, release: 0 });
  assert.equal(s.facing, -1);
  assert.ok(s.prog < prog, `prog ${s.prog}: heads for the nearer end`);
  step(s, 1, 0, false, { press: KEY.R, release: KEY.L });
  assert.equal(s.facing, 1);
  for (let i = 0; i < 20 && s.mode === 'link'; i++) step(s, 1, 0);
  assert.ok(s.mode === 'floor' && s.cell === cell, `${s.mode} on cell ${s.cell}`);
});

/** Cells whose links never stop a sideways move short of the wall. */
const noGallery = (bd, c) => [4, 5, 6, 7].every((d) => !has(bd, c, d));

// A ladder cell in direction d with no gallery, entered by a corridor from a
// west neighbour that has no link toward d.
function ladderCell(d) {
  const toward = DY[d] > 0 ? UP : [3, 6, 7];
  return findCell((bd, c) => has(bd, c, d) && bd.links[c] & 4 && noGallery(bd, c)
    && toward.every((e) => !has(bd, c - 1, e)) && noGallery(bd, world.step(bd, c, d).cell));
}

/** Rock pixels in the explorer's box: x in [X - 5, X + 5), y in [Y, Y + h) over the feet (X, Y). */
function boxRock(w, s, masks) {
  const [fx, fy] = feet(s);
  // drawExplorer rounds screen y, which runs down, so the feet's y rounds as -round(-fy).
  const X = Math.round(fx), Y = -Math.round(-fy), h = s.mode === 'air' ? 16 : 24;
  let n = 0;
  for (let y = Y; y < Y + h; y++) {
    const by = Math.floor(y / BOARD_H);
    for (let x = X - 5; x < X + 5; x++) {
      const bx = Math.floor(x / BOARD_W);
      if (bx < 0 || bx > 5) { n++; continue; }
      const bd = w.board(bx, by);
      if (!masks.has(bd)) masks.set(bd, boardMask(bd));
      if (rockAt(masks.get(bd), x - bx * BOARD_W, y - by * BOARD_H)) n++;
    }
  }
  return n;
}

test('every floor jump peaks at ROOM_CLEAR and lands after 0.5 s, under a ladder shaft too', () => {
  const ladder = findCell((bd, c) => has(bd, c, 1) && noGallery(bd, c));
  const room = findCell((bd, c) => UP.every((d) => !has(bd, c, d)));
  for (const [at, off] of [[ladder, 0], [ladder, 10], [ladder, -10], [room, 0]]) {
    // A jump pressed again in the air changes nothing.
    for (const again of [false, true]) {
      const s = simOn(at, off);
      const go = driver(s);
      let top = 0, ticks = 1;
      go(0, 0, true);
      for (let q = 0; s.mode === 'air' && q < 120; q++) {
        top = Math.max(top, s.alt);
        go(0, 0, again);
        ticks++;
      }
      const label = `off ${off}, ${at === room ? 'room' : 'ladder'}, again ${again}`;
      assert.ok(top <= ROOM_CLEAR && top > ROOM_CLEAR - 1e-9, `${label}: apex ${top}`);
      assert.equal(s.mode, 'floor', label);
      assert.ok(ticks >= 29 && ticks <= 31, `${label}: lands on tick ${ticks}`);
      assert.equal(s.stats.jumps, 1, label);
    }
  }
});

/**
 * x after `ticks` ticks of input from the floor of `s`, a jump launched on the
 * first: side h from tick `from`. Returns x and the apex.
 */
function runAfter(s, go, ticks, from, jump) {
  let top = 0;
  for (let i = 0; i < ticks; i++) {
    go(i >= from ? 1 : 0, 0, jump && i === 0);
    if (s.mode === 'air') top = Math.max(top, s.alt);
  }
  return { x: feet(s)[0], top };
}

test('a jump on the tick after a ladder\'s top peaks at ROOM_CLEAR and keeps run speed', () => {
  // The top cell runs east along two corridors without galleries.
  const at = findCell((bd, c) => c < 72 && c % 12 < 10 && has(bd, c, 1) && noGallery(bd, c + 12) && noGallery(bd, c + 13)
    && bd.links[c + 12] & 1 && bd.links[c + 13] & 1);
  const ran = (jump) => {
    const s = simOn(at);
    const go = driver(s);
    // Sixty climb ticks of 0.8 px sum to a hair under 48: the top carries nothing back.
    for (let i = 0; i < 80 && !(s.mode === 'floor' && s.cell === at.cell + 12); i++) go(0, 1);
    assert.ok(s.mode === 'floor' && s.cell === at.cell + 12);
    return runAfter(s, go, 45, 0, jump);
  };
  const hop = ran(true), base = ran(false);
  assert.ok(hop.top <= ROOM_CLEAR, `apex ${hop.top}`);
  assert.ok(Math.abs(hop.x - base.x) < 1e-9, `${hop.x} vs ${base.x}`);
});

test('a jump after a ladder trip that leaves a hair of carry keeps run speed', () => {
  const at = findCell((bd, c) => c % 12 < 10 && has(bd, c, 1) && noGallery(bd, c) && noGallery(bd, c + 1)
    && bd.links[c] & 1 && bd.links[c + 1] & 1);
  const ran = (jump) => {
    const s = simOn(at);
    const go = driver(s);
    for (let i = 0; i < 20; i++) go(0, 1);
    for (let i = 0; i < 40 && s.mode === 'link'; i++) go(0, -1);
    assert.ok(s.mode === 'floor' && s.carry > 0 && s.carry < 1e-12, `carry ${s.carry}`);
    // Straight up, then east from tick 5: the apex comes 16 px out, past the shaft.
    return runAfter(s, go, 45, 5, jump);
  };
  const hop = ran(true), base = ran(false);
  assert.ok(hop.top <= ROOM_CLEAR + 1e-9, `apex ${hop.top}`);
  assert.ok(Math.abs(hop.x - base.x) < 1e-9, `${hop.x} vs ${base.x}`);
});

test('Up held through a jump\'s descent grabs the ladder under its shaft only', () => {
  const at = findCell((bd, c) => has(bd, c, 1) && noGallery(bd, c));
  for (const off of [10, -10, 0]) {
    const s = simOn(at, off);
    const go = driver(s);
    go(0, 0, true);
    for (let q = 0; s.vy > 0 && q < 60; q++) go(0, 0);
    let before = null;
    for (let q = 0; s.mode === 'air' && q < 120; q++) {
      before = s.mode;
      go(0, 1);
    }
    if (off) assert.ok(s.mode === 'floor' && s.stats.airGrabs === 0, `off ${off}: ${s.mode}`);
    else assert.ok(before === 'air' && s.mode === 'link' && s.link === 1 && s.prog > 0, `${s.mode} ${s.prog}`);
  }
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

test('over an up-stair a jump lands on the leading foot past the room wall, else flies its arc', () => {
  for (const g of [4, 5]) {
    const at = findCell((bd, c) => has(bd, c, g));
    const dir = DX[g], masks = new Map();
    // Straight up from the cell centre: the full arc, onto the floor.
    const up = simOn(at, 0, dir);
    const hop = driver(up);
    let ticks = 1;
    hop(0, 0, true);
    for (let q = 0; up.mode === 'air' && q < 120; q++) {
      assert.equal(boxRock(world, up, masks), 0, `dir ${g}: rock at alt ${up.alt}`);
      hop(0, 0);
      ticks++;
    }
    assert.ok(up.mode === 'floor' && ticks >= 29 && ticks <= 31, `dir ${g}: ${up.mode} after ${ticks} ticks`);
    // A running jump from the far side lands on the stair under its leading foot.
    const s = simOn(at, -11 * dir, dir);
    const go = driver(s);
    let prev = null;
    go(dir, 0, true);
    for (let q = 0; s.mode === 'air' && q < 120; q++) {
      assert.equal(boxRock(world, s, masks), 0, `dir ${g}: rock at off ${s.off}, alt ${s.alt}`);
      prev = { off: s.off, alt: s.alt, vy: s.vy, x: feet(s)[0] };
      go(dir, 0);
    }
    assert.ok(prev, `dir ${g}: airborne the tick before`);
    assert.ok(s.mode === 'link' && s.link === g && s.stats.stairLandings === 1, `dir ${g}: ${s.mode}`);
    assert.ok(prev.alt > prev.off * dir + 5, `dir ${g}: leading foot above the stair the tick before`);
    // The landing keeps the feet's x and engages at the prog under them.
    const x = prev.x + dir * RUN_SPEED * TICK, k = (x - nodeXY(at.bd, at.cell)[0]) * dir;
    assert.ok(k > 11, `dir ${g}: lands at off ${k}`);
    assert.ok(Math.abs(feet(s)[0] - x) < 1e-9 && Math.abs(s.prog - k * Math.SQRT2) < 1e-9, `dir ${g}: prog ${s.prog}`);
    const alt = prev.alt + prev.vy * TICK - GRAVITY * TICK * TICK / 2;
    assert.ok(alt >= k && alt - k <= 5, `dir ${g}: feet drop ${alt - k}`);
  }
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

/**
 * A jump from offset `off` in `at`, straight up until tick m, then toward
 * the stair; Up held from the tick after launch when `holdUp`. Each entry is
 * the state after a tick: mode, prog, and the landing point's gap over the
 * stair.
 */
function stairTrace(at, g, off, m, holdUp) {
  const s = simOn(at, off, DX[g]);
  const go = driver(s);
  const out = [];
  go(m === 0 ? DX[g] : 0, 0, true);
  for (let i = 1; i < 40 && s.mode === 'air'; i++) {
    go(i >= m ? DX[g] : 0, holdUp ? 1 : 0);
    const k = s.off * DX[g];
    out.push({ mode: s.mode, prog: s.prog, k, over: k >= 0, gap: s.alt - (k > 11 ? k + 5 : k) });
  }
  return out;
}

test('Up held in the air engages an up-gallery once its landing point comes within 4 px of the stair', () => {
  for (const g of [4, 5]) {
    const at = findCell((bd, c) => has(bd, c, g));
    let windows = 0, landings = 0;
    // From the centre, toward the stair from tick m; from the far side, at once.
    const runs = [...Array(29).keys()].map((m) => [0, m + 1]).concat([[-11 * DX[g], 0], [-9 * DX[g], 0]]);
    for (const [off, m] of runs) {
      const held = stairTrace(at, g, off, m, true), free = stairTrace(at, g, off, m, false);
      const t = held.findIndex((p) => p.mode === 'link');
      // Entry -1 is the launch tick, airborne.
      assert.ok(t >= 0 && (t === 0 || held[t - 1].mode === 'air'), `dir ${g}, off ${off}, m ${m}: airborne before engaging`);
      for (let j = 0; j < t; j++) {
        assert.ok(free[j].mode === 'air' && (!free[j].over || free[j].gap > STAIR_REACH), `dir ${g}, off ${off}, m ${m}: window open at ${j}`);
      }
      if (free[t].mode === 'air') {
        // Without Up the arc is still airborne there, its landing point 0-4 px over the stair.
        assert.ok(free[t].over && free[t].gap > 0 && free[t].gap <= STAIR_REACH, `dir ${g}, off ${off}, m ${m}: gap ${free[t].gap}`);
        assert.ok(Math.abs(held[t].prog - free[t].k * Math.SQRT2) < 1e-9, `dir ${g}, off ${off}, m ${m}: prog ${held[t].prog}`);
        windows++;
      } else {
        // The tick that crosses off 11 skips the window; the stair landing catches it.
        assert.equal(free[t].mode, 'link', `dir ${g}, off ${off}, m ${m}`);
        assert.equal(held[t].prog, free[t].prog);
        landings++;
      }
    }
    assert.ok(windows > 0 && landings > 0, `dir ${g}: ${windows} windows, ${landings} landings`);
  }
});

test('Up held in the air moving away from an up-gallery never engages it', () => {
  for (const g of [4, 5]) {
    const at = findCell((bd, c) => has(bd, c, g));
    let near = 0;
    // A run toward the stair from the centre lands on it at tick 7.
    for (let m = 2; m <= 6; m++) {
      // Toward the stair until tick m, then away from it with Up held.
      const s = simOn(at, 0, DX[g]);
      const go = driver(s);
      go(DX[g], 0, true);
      for (let i = 1; i < 40 && s.mode === 'air'; i++) {
        go(i < m ? DX[g] : -DX[g], i < m ? 0 : 1);
        const k = s.off * DX[g];
        if (i >= m && s.mode === 'air' && k >= 0 && s.alt - k <= STAIR_REACH) near++;
      }
      assert.equal(s.mode, 'floor', `dir ${g}, m ${m}`);
    }
    assert.ok(near > 0, `dir ${g}: never within the window`);
  }
});

test('in the air a down-gallery mouth keeps the explorer out', () => {
  for (const g of [7, 6]) {
    const s = simOn(findCell((bd, c) => has(bd, c, g)), -5 * DX[g], DX[g]);
    const go = driver(s);
    let air = 0;
    go(DX[g], 0, true);
    for (let q = 0; s.mode === 'air' && q < 120; q++) {
      assert.ok(s.off * DX[g] <= 0, `dir ${g}: off ${s.off}`);
      go(DX[g], 0);
      air++;
    }
    assert.ok(air >= 29);
  }
});

test('a jump neither speeds nor slows a run along corridors, across a ladder-up cell too', () => {
  const straight = (bd, c) => c % 12 < 9 && [c, c + 1, c + 2].every((u) => bd.links[u] & 1 && noGallery(bd, u));
  const plain = findCell((bd, c) => straight(bd, c) && [c, c + 1, c + 2].every((u) => UP.every((d) => !has(bd, u, d))));
  const ladder = findCell((bd, c) => straight(bd, c) && has(bd, c + 1, 1));
  for (const at of [plain, ladder]) {
    const ran = (jumpAt) => {
      const s = simOn(at);
      const go = driver(s);
      for (let i = 0; i < 60; i++) go(1, 0, i === jumpAt);
      return { x: feet(s)[0], jumps: s.stats.jumps };
    };
    const base = ran(-1);
    for (let j = 0; j < 60; j++) {
      const hop = ran(j);
      assert.equal(hop.jumps, 1);
      assert.ok(Math.abs(hop.x - base.x) < 1e-9, `${at === ladder ? 'ladder' : 'plain'} run, jump at ${j}: ${hop.x} vs ${base.x}`);
    }
  }
});

test('a run with Right held that buffers a tap onto a ladder stops there; a Right press dismounts, a jump hops', () => {
  for (const d of [1, 3]) {
    const at = ladderCell(d), key = DY[d] > 0 ? KEY.U : KEY.D;
    const parked = () => {
      // From 12 px short of the shared wall: the tap rides the buffer into the ladder cell.
      const s = simOn({ bd: at.bd, cell: at.cell - 1 }, 12);
      step(s, 1, 0, false, { press: KEY.R | key, release: key });
      let engaged = -1;
      for (let i = 0; i < 60; i++) {
        step(s, 1, 0);
        if (engaged < 0 && s.mode === 'link') engaged = i;
        if (engaged >= 0) assert.ok(s.mode === 'link' && s.link === d && s.prog === 0, `dir ${d}, tick ${i}: ${s.mode} ${s.prog}`);
      }
      assert.ok(engaged >= 0 && engaged < 30, `dir ${d}: engaged at ${engaged}`);
      return s;
    };
    const s = parked();
    step(s, 0, 0, false, { press: 0, release: KEY.R });
    assert.equal(s.mode, 'link');
    step(s, 1, 0, false, { press: KEY.R, release: 0 });
    assert.ok(s.mode === 'floor' && s.cell === at.cell && s.stats.dismounts === 1, `dir ${d}: ${s.mode} on ${s.cell}`);
    for (let i = 0; i < 5; i++) step(s, 1, 0);
    assert.ok(s.mode === 'floor' && s.off > 0, `dir ${d}: walks right, off ${s.off}`);
    const j = parked();
    const go = driver(j);
    let top = 0;
    go(0, 0, true);
    for (let q = 0; j.mode === 'air' && q < 120; q++) { top = Math.max(top, j.alt); go(0, 0); }
    assert.ok(top > ROOM_CLEAR - 1e-9 && j.mode === 'floor' && j.cell === at.cell, `dir ${d}: apex ${top}, ${j.mode} on ${j.cell}`);
  }
});

test('a side press on a ladder dismounts to the nearer end; Up or Down held keeps the explorer on the ladder', () => {
  for (const d of [1, 3]) {
    const at = ladderCell(d), far = world.step(at.bd, at.cell, d).cell;
    for (const [n, end] of [[12, at.cell], [48, far]]) {
      const s = simOn(at);
      const go = driver(s);
      for (let i = 0; i < n; i++) go(0, DY[d]);
      assert.ok(s.mode === 'link' && Math.abs(s.prog - 0.8 * n) < 1e-9, `dir ${d}: prog ${s.prog}`);
      for (let i = 0; i < 40 && s.mode === 'link'; i++) go(1, 0);
      assert.ok(s.mode === 'floor' && s.cell === end && s.stats.dismounts === 1, `dir ${d}, prog ${0.8 * n}: ${s.mode} on ${s.cell}`);
      const off = s.off;
      go(1, 0);
      assert.ok(s.off > off, `dir ${d}: walks on`);
    }
    // A side pressed with Up or Down held moves along the ladder; the press then lapses.
    const s = simOn(at);
    const go = driver(s);
    for (let i = 0; i < 12; i++) go(0, DY[d]);
    let prog = s.prog;
    for (let i = 0; i < 10; i++) {
      go(1, DY[d]);
      assert.ok(s.mode === 'link' && s.prog > prog, `dir ${d}, tick ${i}: prog ${s.prog}`);
      prog = s.prog;
    }
    go(1, 0);
    assert.ok(s.mode === 'link' && s.prog === prog, `dir ${d}: a held side stays on the ladder`);
    assert.equal(s.stats.dismounts, 0);
  }
});

test('a side press from a ladder\'s midpoint on dismounts to its far end', () => {
  const at = ladderCell(1), far = world.step(at.bd, at.cell, 1).cell;
  for (const [prog, end] of [[24, far], [24 - 1e-6, at.cell]]) {
    const s = simOn(at);
    const go = driver(s);
    go(0, 1);
    s.prog = prog;
    for (let i = 0; i < 40 && s.mode !== 'floor'; i++) go(1, 0);
    assert.ok(s.mode === 'floor' && s.cell === end, `prog ${prog}: ${s.mode} on ${s.cell}`);
  }
});

test('a jump on a ladder lets go and lands on its lower cell', () => {
  for (const d of [1, 3]) {
    const at = ladderCell(d), link = world.step(at.bd, at.cell, d);
    const s = simOn(at);
    const go = driver(s);
    for (let i = 0; i < 38; i++) go(0, DY[d]);
    const [x, y] = feet(s);
    go(0, 0, true);
    const lower = d === 1 ? at.cell : link.cell;
    assert.ok(s.mode === 'air' && s.cell === lower && s.stats.letGos === 1, `dir ${d}: ${s.mode} on ${s.cell}`);
    assert.equal(feet(s)[0], x);
    assert.ok(Math.abs(feet(s)[1] - (y - GRAVITY * TICK * TICK / 2)) < 1e-9, `dir ${d}: drops from the feet`);
    for (let q = 0; s.mode === 'air' && q < 120; q++) go(0, 0);
    assert.ok(s.mode === 'floor' && s.cell === lower && s.bd === at.bd, `dir ${d}: ${s.mode} on ${s.cell}`);
  }
  // Down through a floor door: the let-go crosses the seam.
  const door = findCell((bd, c) => bd.doorMask[c] & 8);
  const below = world.step(door.bd, door.cell, 3);
  const s = simOn(door);
  const go = driver(s);
  for (let i = 0; i < 38; i++) go(0, -1);
  assert.ok(s.mode === 'link' && s.link === 3 && s.bd === door.bd);
  go(0, 0, true);
  assert.ok(s.events.includes('seam') && s.bd === below.board && s.cell === below.cell, 'lands on the board below');
  const masks = new Map();
  for (let q = 0; s.mode === 'air' && q < 120; q++) {
    assert.equal(boxRock(world, s, masks), 0, `rock at alt ${s.alt}`);
    go(0, 0);
  }
  assert.ok(s.mode === 'floor' && s.bd === below.board && s.cell === below.cell);
});

test('after a let-go, held Up grabs nothing until pressed anew; on landing it takes the ladder', () => {
  const at = ladderCell(1);
  const climb = () => {
    const s = simOn(at);
    const go = driver(s);
    for (let i = 0; i < 38; i++) go(0, 1);
    go(0, 1, true);
    assert.equal(s.mode, 'air');
    return [s, go];
  };
  const [s, go] = climb();
  for (let q = 0; s.mode === 'air' && q < 120; q++) go(0, 1);
  assert.ok(s.mode === 'floor' && s.stats.airGrabs === 0, `${s.mode}`);
  go(0, 1);
  assert.ok(s.mode === 'link' && s.link === 1, 'held Up takes the ladder from the floor');
  const [r, again] = climb();
  again(0, 0);
  again(0, 1);
  assert.ok(r.mode === 'link' && r.link === 1 && r.prog > 0 && r.stats.airGrabs === 1, `${r.mode} ${r.prog}`);
});

test('after a let-go lands, Up held since then grabs a ladder in a later jump', () => {
  // Let go of L's ladder and land holding Up, which climbs to U; from U a
  // running jump carries the explorer under V's ladder shaft.
  const at = findCell((bd, c) => has(bd, c, 1) && noGallery(bd, c) && UP.every((d) => !has(bd, c + 12, d))
    && (c + 12) % 12 < 11 && bd.links[c + 12] & 1 && has(bd, c + 13, 1));
  const s = simOn(at);
  const go = driver(s);
  for (let i = 0; i < 38; i++) go(0, 1);
  go(0, 1, true);
  for (let i = 0; i < 200 && s.cell !== at.cell + 12; i++) go(0, 1);
  assert.ok(s.mode === 'floor' && s.cell === at.cell + 12, `${s.mode} on ${s.cell}`);
  go(1, 1, true);
  for (let i = 0; i < 40 && s.mode === 'air'; i++) go(1, 1);
  assert.ok(s.mode === 'link' && s.link === 1 && s.cell === at.cell + 13 && s.stats.airGrabs === 1, `${s.mode} on ${s.cell}`);
});

test('after a let-go above the room, the shaft holds the explorer until its head drops below the ceiling', () => {
  const at = ladderCell(1);
  const s = simOn(at);
  const go = driver(s);
  for (let i = 0; i < 50; i++) go(0, 1);
  go(1, 0, true);
  let high = 0;
  for (let q = 0; s.mode === 'air' && q < 120; q++) {
    if (s.alt > ROOM_CLEAR) { high++; assert.ok(Math.abs(s.off) <= SHAFT_REACH, `off ${s.off} at alt ${s.alt}`); }
    go(1, 0);
  }
  assert.ok(high > 5 && s.off > SHAFT_REACH, `${high} ticks high, off ${s.off}`);
});

test('a jump on a gallery changes nothing, and a side press there moves along it', () => {
  for (const g of [4, 5]) {
    const s = simAt(g, 1);
    const go = driver(s);
    for (let i = 0; i < 10; i++) go(0, 1);
    const prog = s.prog;
    go(0, 1, true);
    assert.ok(s.mode === 'link' && s.link === g && Math.abs(s.prog - prog - GALLERY_SPEED * TICK) < 1e-9, `dir ${g}: ${s.mode} ${s.prog}`);
    for (let i = 0; i < 60 && s.mode === 'link'; i++) go(DX[g], 0);
    assert.ok(s.mode === 'floor' && s.stats.jumps === 0 && s.stats.letGos === 0 && s.stats.dismounts === 0, `dir ${g}`);
    assert.equal(s.stats.ladderUp, 0, `dir ${g}: a gallery is no ladder`);
  }
});

test('on a gallery the explorer faces the way it walks and its frames advance', () => {
  for (const g of [4, 5]) {
    const s = simAt(g, 1);
    const go = driver(s);
    const frames = new Set();
    for (let i = 0; i < 20; i++) { go(0, 1); frames.add(pose(s).frame); }
    assert.ok(s.mode === 'link' && s.facing === DX[g] && frames.size > 2, `dir ${g}: up`);
    go(0, -1);
    assert.ok(s.mode === 'link' && s.facing === -DX[g], `dir ${g}: down`);
  }
});

test('an engaged link spends a buffered tap in its direction', () => {
  for (const g of [4, 5]) {
    const s = simOn(findCell((bd, c) => has(bd, c, g)), 0, DX[g]);
    step(s, 0, 0, true);
    for (let i = 1; i < 28; i++) step(s, 0, 0);
    // An Up tap buffers in the air; a late drift then lands on the stair near its foot.
    step(s, 0, 0, false, { press: KEY.U, release: KEY.U });
    for (let i = 0; i < 4 && s.mode === 'air'; i++) step(s, DX[g], 0);
    assert.ok(s.mode === 'link' && s.link === g && s.stats.stairLandings === 1, `dir ${g}: ${s.mode}`);
    // Down walks back to the floor while the tap would still be buffered.
    step(s, 0, -1, false, { press: KEY.D, release: 0 });
    for (let i = 0; i < 6 && s.mode === 'link'; i++) step(s, 0, -1);
    assert.equal(s.mode, 'floor', `dir ${g}`);
    step(s, 0, 0, false, { press: 0, release: KEY.D });
    step(s, 0, 0);
    assert.equal(s.mode, 'floor', `dir ${g}: the spent tap engages nothing`);
  }
});

test('the explorer never leaves a cell except along a link or door, nor enters rock', () => {
  // Random arrows and jumps from the entries of 7 bands in each of 4 seeds.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
  let moves = 0, jumps = 0, air = 0, bands = 0, dismounts = 0, letGos = 0, overStair = 0, boxes = 0;
  for (const code of ['00000000', '000001C3', 'K7Q2M9XA', 'ZZZZZZZZ']) {
    const w = createWorld(code);
    for (let b = -3; b <= 3; b++) {
      bands++;
      const s = createSim(w, w.resumePoint(w.tree(b).entryX, 4 * b));
      const masks = new Map();
      let h = 0, v = 0, ph = 0, pv = 0, prev = [s.bd, s.cell];
      for (let i = 0; i < 3000; i++) {
        if (i % 20 === 0) { h = (rnd() % 3) - 1; v = (rnd() % 3) - 1; }
        step(s, h, v, rnd() % 12 === 0, inputEdges(ph, pv, h, v));
        ph = h;
        pv = v;
        s.burn = BURN_S;
        if (s.mode !== 'link') {
          boxes++;
          const rock = boxRock(w, s, masks);
          assert.equal(rock, 0, `${code}: ${rock} rock px in ${s.mode} on (${s.bd.x},${s.bd.y}):${s.cell} off ${s.off} alt ${s.alt}`);
          const stair = w.step(s.bd, s.cell, 4) ? 1 : w.step(s.bd, s.cell, 5) ? -1 : 0;
          if (s.mode === 'air' && s.off * stair > 0) overStair++;
        }
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
      dismounts += s.stats.dismounts;
      letGos += s.stats.letGos;
    }
  }
  assert.ok(bands >= 25);
  assert.ok(moves > 300, `only ${moves} moves`);
  assert.ok(jumps > 500, `only ${jumps} jumps`);
  assert.ok(air > 30, `only ${air} air grabs and stair landings`);
  assert.ok(dismounts > 10, `only ${dismounts} dismounts`);
  assert.ok(letGos > 200, `only ${letGos} let-gos`);
  assert.ok(overStair > 25, `only ${overStair} air ticks over an up-stair`);
  assert.ok(boxes > 50000, `only ${boxes} boxes checked`);
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

test('both jump frames tuck into rows 8-23 with the torch tip on a drawn row', () => {
  for (const f of [0, 1]) {
    const rows = EXPLORER.jump[f];
    assert.equal(rows.length, 24);
    for (let y = 0; y < 8; y++) assert.match(rows[y], /^\.+$/, `frame ${f}, row ${y}`);
    const [, y] = torchTip('jump', f);
    assert.ok(y >= 8 && /[^.]/.test(rows[y]), `frame ${f}: torch tip row ${y}`);
  }
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

