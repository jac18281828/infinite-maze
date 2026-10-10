import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld, digestBands, serializeBoard, posOf, boardOfPos, bandOf, boardCoords, midpointIndex, routeBands,
} from '../src/world/world.mjs';
import { COST, DX, DY, NCELL, growTree, repairTree, analyze } from '../src/world/board.mjs';
import { parseCode, formatCode, codeFromBytes, makeHasher, worldKey, sfc32 } from '../src/world/hash.mjs';
import { encodeSave, decodeSave } from '../src/world/save.mjs';
import { MIN_ROUTE, MAX_DEPTH, WALL_DIR } from '../src/world/band.mjs';
import { createRoute, blockSize, blockOrigin, blockOf, WX, WY } from '../src/world/route.mjs';
import {
  checkFlames, checkDeterminism, checkBalance, checkBounds, bandShape, walkRoute, walkMs, measureTargets,
} from '../tools/acceptance.mjs';

// Pinned digest of route bands 0..99 for seed code 0000-0000.
const DIGEST = 'fa03489590d49a1c64f06086375de71275df12002662c049dfa3991b55606953';

test('seed 0000-0000 yields the pinned digest over route bands 0..99', () => {
  assert.equal(digestBands(createWorld('00000000'), 0, 99), DIGEST);
  assert.deepEqual(checkDeterminism('00000000', DIGEST).errors, []);
});

test('a different seed yields a different digest', () => {
  assert.notEqual(digestBands(createWorld('K7Q2M9XA'), 0, 3), digestBands(createWorld('00000000'), 0, 3));
});

test('seed codes canonicalise Crockford aliases and reject bad input', () => {
  assert.equal(parseCode('k7q2-m9xa'), 'K7Q2M9XA');
  assert.equal(parseCode('IL0O-0000'), '11000000');
  assert.equal(parseCode('ABCD-EFGU'), null);
  assert.equal(parseCode('ABC'), null);
  assert.equal(formatCode('K7Q2M9XA'), 'K7Q2-M9XA');
  assert.equal(codeFromBytes([0, 0, 0, 0, 0]), '00000000');
  assert.equal(codeFromBytes([255, 255, 255, 255, 255]), 'ZZZZZZZZ');
});

test('saves round-trip for negative and mixed-sign (x, y)', () => {
  const edge = 2 ** 25 - 1;
  const cases = [[0, 0], [5, 3], [-1, 0], [0, -1], [-7, -12], [-7, 12], [12, -7], [-4000, 999999], [edge, -edge], [-edge, edge]];
  for (const [x, y] of cases) {
    const text = encodeSave('K7Q2M9XA', x, y);
    assert.match(text, /^K7Q2-M9XA:\d+$/);
    assert.ok(text.length <= 26, text);
    assert.deepEqual(decodeSave(text), { code: 'K7Q2M9XA', p: posOf(x, y), x, y });
  }
  // z(-1) = 1, z(0) = 0: p = a^2 + a + b for a >= b, else a + b^2.
  assert.equal(encodeSave('K7Q2M9XA', -1, 0), 'K7Q2-M9XA:2');
  assert.equal(encodeSave('K7Q2M9XA', 0, -1), 'K7Q2-M9XA:1');
  assert.deepEqual(boardOfPos(4813), { x: 26, y: -35 });
  assert.deepEqual(decodeSave('k7q2m9xa:4813'), { code: 'K7Q2M9XA', p: 4813, x: 26, y: -35 });
  // Every p below 10,000 names a distinct board and pairs back to itself.
  const seen = new Set();
  for (let p = 0; p < 10000; p++) {
    const { x, y } = boardOfPos(p);
    assert.equal(posOf(x, y), p);
    seen.add(`${x},${y}`);
  }
  assert.equal(seen.size, 10000);
  assert.equal(decodeSave('K7Q2-M9XA'), null);
  assert.equal(decodeSave('K7Q2-M9XA:1.5'), null);
  assert.equal(decodeSave('K7Q2-M9XA:-4'), null);
  assert.equal(decodeSave('K7Q2-M9XU:3'), null);
});

test('out-of-range coordinates decode to null', () => {
  const limit = 2 ** 25;
  for (const [x, y] of [[limit, 0], [-limit, 0], [0, limit], [3, -limit], [limit, -limit]]) {
    const p = posOf(x, y);
    assert.ok(Number.isSafeInteger(p), `p ${p}`);
    assert.deepEqual(boardOfPos(p), { x, y });
    assert.equal(decodeSave(`K7Q2-M9XA:${p}`), null, `(${x}, ${y})`);
  }
  assert.equal(decodeSave('K7Q2-M9XA:9007199254740993'), null);
});

test('a board resumed from p serializes identically to the same board reached along the route', () => {
  const seq = createWorld('00000000');
  const bands = routeBands(seq, 0, 22);
  for (const { u, v } of bands) {
    for (let i = 0; i < 24; i++) { const { x, y } = boardCoords(u, v, i); seq.board(x, y); }
    seq.bandFlames(u, v);
  }
  // Route bands 0, 2, 8 and 22 lie in the four quadrants of (u, v).
  const at = [];
  for (const { u, v } of [bands[0], bands[2], bands[8], bands[22]]) {
    const e = seq.entryBoard(u, v);
    at.push([e.x, e.y], [6 * u + 2, 4 * v + 1], [6 * u + 5, 4 * v + 3]);
  }
  const signs = new Set(at.map(([x, y]) => `${Math.sign(x) < 0}${Math.sign(y) < 0}`));
  assert.equal(signs.size, 4, 'every sign of (x, y)');
  for (const [x, y] of at) {
    const save = decodeSave(encodeSave('00000000', x, y));
    const fresh = createWorld(save.code);
    assert.deepEqual(serializeBoard(fresh, save.x, save.y), serializeBoard(seq, x, y), `(${x},${y})`);
  }
});

test('a resume lands on the door back toward the band entry; rock resumes at a band entry', () => {
  const w = createWorld('00000000');
  // The first route band after the start that holds a rock board.
  const { u, v } = routeBands(w, 1, 40).find((b) => w.tree(b.u, b.v).depth.includes(-1));
  const t = w.tree(u, v);
  const e = w.entryBoard(u, v);
  const entry = w.resumePoint(e.x, e.y);
  assert.equal(entry.cell, e.doors.find((d) => d.dir === WALL_DIR[t.entryWall]).cell);
  const second = boardCoords(u, v, t.route[1]);
  const r = w.resumePoint(second.x, second.y);
  assert.ok(r.board.x === second.x && r.board.y === second.y && r.cell === r.board.a);
  const at = boardCoords(u, v, t.depth.indexOf(-1));
  assert.equal(w.board(at.x, at.y).kind, 'rock');
  assert.equal(w.resumePoint(at.x, at.y).board, e);
  // A board of a rock band resumes at the start band's entry.
  let rockBand = null;
  for (let du = -3; du <= 3 && !rockBand; du++) for (let dv = -3; dv <= 3 && !rockBand; dv++) if (w.tree(u + du, v + dv).rock) rockBand = [u + du, v + dv];
  assert.ok(rockBand, 'a rock band near the route band');
  const start = w.resumePoint(6 * rockBand[0] + 3, 4 * rockBand[1] + 1);
  assert.equal(start.board, w.entryBoard(0, 0));
  assert.deepEqual(start, w.startPoint());
});

test('band trees keep a route of 12+ boards, or one corner board, and dead ends at most 2 deep', () => {
  const w = createWorld('00000000');
  const walk = walkRoute(w, -40, 40);
  assert.deepEqual(walk.errors, []);
  for (const rb of walk.bands) {
    const t = w.tree(rb.u, rb.v);
    assert.ok(t.route.length >= MIN_ROUTE || t.entry === t.exit, `band (${rb.u},${rb.v})`);
    assert.ok(Math.max(...t.depth) <= MAX_DEPTH);
    assert.equal(t.route[0], t.entry);
    assert.equal(t.route.at(-1), t.exit);
    assert.deepEqual(bandShape(w, rb).route, t.route, `band (${rb.u},${rb.v})`);
  }
});

test('a corner band whose entry and exit share a board builds a one-board route with dead ends', () => {
  const w = createWorld('00000000');
  const corners = routeBands(w, -200, 200).filter(({ u, v }) => { const t = w.tree(u, v); return t.entry === t.exit; });
  assert.ok(corners.length >= 3, `${corners.length} corner bands`);
  for (const { u, v } of corners) {
    const t = w.tree(u, v);
    assert.ok([0, 5, 18, 23].includes(t.entry), `band (${u},${v}) board ${t.entry}`);
    assert.deepEqual(t.route, [t.entry]);
    assert.notEqual(t.entryWall, t.exitWall);
    const dead = [...t.depth].filter((d) => d > 0);
    assert.ok(dead.length > 0 && Math.max(...dead) <= MAX_DEPTH, `band (${u},${v}) dead ends`);
    assert.equal([...t.depth].filter((d) => d === 0).length, 1);
    const bd = w.entryBoard(u, v);
    assert.ok(bd.a !== bd.b && bd.aDir === WALL_DIR[t.entryWall] && bd.bDir === WALL_DIR[t.exitWall]);
  }
  // The harness, from doors alone, finds the nearest one's one-board route and passes its bounds.
  const near = corners.reduce((a, b) => (Math.abs(b.index) < Math.abs(a.index) ? b : a));
  const lo = Math.min(near.index, 0), hi = Math.max(near.index, 0);
  const rb = walkRoute(w, lo, hi).at(near.index);
  const bd = w.entryBoard(near.u, near.v);
  assert.ok(rb.entry.board === bd && rb.exit.board === bd);
  assert.deepEqual(bandShape(w, rb).route, w.tree(near.u, near.v).route);
  assert.deepEqual(checkBounds(w, near.index, near.index).errors, []);
});

test('bandOf floors toward negative infinity on both axes', () => {
  assert.deepEqual(bandOf(-1, -1), { u: -1, v: -1 });
  assert.deepEqual(bandOf(-6, -4), { u: -1, v: -1 });
  assert.deepEqual(bandOf(-7, -5), { u: -2, v: -2 });
  assert.deepEqual(bandOf(5, 3), { u: 0, v: 0 });
  assert.deepEqual(bandOf(6, 4), { u: 1, v: 1 });
});

test('the generator walks a route of adjacent bands from (0, 0) both ways, and prev undoes next', () => {
  const w = createWorld('00000000');
  const bands = routeBands(w, -300, 300);
  assert.deepEqual(bands[300], { u: 0, v: 0, index: 0 });
  assert.equal(new Set(bands.map((b) => `${b.u},${b.v}`)).size, bands.length);
  for (let i = 1; i < bands.length; i++) {
    const a = bands[i - 1], b = bands[i];
    assert.equal(Math.abs(a.u - b.u) + Math.abs(a.v - b.v), 1);
    assert.deepEqual(w.prev(b.u, b.v), { u: a.u, v: a.v });
  }
});

test('every level\'s grid aligns with the one below, and the route enters each block once', () => {
  for (let k = 2; k <= 6; k++) {
    // o_k - o_{k-1} = -S_{k-1}, and child (a, b) of block (k, i, j) is block (k-1, 3i-1+a, 3j-1+b).
    assert.equal(blockOrigin(k) - blockOrigin(k - 1), -blockSize(k - 1));
    for (let u = -50; u <= 50; u++) assert.equal(blockOf(k, u), Math.floor((blockOf(k - 1, u) + 1) / 3));
  }
  const bands = routeBands(createWorld('00000000'), -2000, 2000);
  const runs = new Map();
  let last = null;
  for (const b of bands) {
    const key = `${blockOf(3, b.u)},${blockOf(3, b.v)}`;
    if (key !== last) runs.set(key, (runs.get(key) || 0) + 1);
    last = key;
  }
  assert.ok(runs.size > 50);
  for (const [key, n] of runs) assert.equal(n, 1, `level-3 block ${key} entered ${n} times`);
});

test('the generator refuses levels above 20', () => {
  const w = createWorld('00000000');
  assert.ok(w.startChain(20));
  assert.throws(() => w.startChain(21), /above 20/);
  // The level-20 start block spans bands -(3^19 - 1) / 2 .. (3^19 - 1) / 2.
  const half = (3 ** 19 - 1) / 2;
  assert.doesNotThrow(() => w.locate(-half, half));
  assert.throws(() => w.locate(half + 1, 0), /above 20/);
});

test('ROUTE section 7 cross-check: seed 0000-0000 routes 1,861,285 bands through its level-9 start block', () => {
  const route = createRoute(makeHasher(worldKey('00000000')));
  const count = (r) => {
    if (r.k === 1) return 1;
    let n = 0;
    for (let t = 0; t < r.path.length; t++) n += count(route.childRoute(r, t));
    return n;
  };
  assert.equal(count(route.startRoute(9)), 1861285);
  // Drift, the ring max(|u|, |v|), after 1,000 and 100,000 bands of route.
  let u = 0, v = 0;
  const ring = [];
  for (let i = 1; i <= 100000; i++) {
    const { X } = route.locate(u, v);
    u += WX[X];
    v += WY[X];
    if (i === 1000 || i === 100000) ring.push(Math.max(Math.abs(u), Math.abs(v)));
  }
  assert.deepEqual(ring, [34, 749]);
});

test('balance accepts the generator\'s route bands 0..10,000 and rejects the stacked sequence', () => {
  const route = routeBands(createWorld('00000000'), 0, 10000);
  const ok = checkBalance(route);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.moves, 10000);
  assert.ok(ok.shares.every((s) => s >= 20 && s <= 30), ok.shares.join(' '));
  // Stacked bands (0, n) climb on every move.
  const stacked = Array.from({ length: 10001 }, (_, n) => ({ u: 0, v: n }));
  const r = checkBalance(stacked);
  assert.deepEqual(r.shares, [0, 0, 0, 100]);
  assert.ok(r.errors.some((e) => e.startsWith('U carries 100.0%')), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => e.startsWith('L carries 0.0%')), r.errors.join('\n'));
});

test('gap splitting adds midpoint flames until every gap fits the limit', () => {
  const limit = 20000;
  const w = createWorld('00000000', { gapLimitMs: limit });
  let extra = 0;
  for (const { u, v } of routeBands(w, 0, 4)) {
    const fs = w.bandFlames(u, v);
    extra += fs.flames.filter((f) => f.kind === 'gap').length;
    assert.ok(fs.gaps.every((g) => g <= limit), `band (${u},${v})`);
    assert.equal(fs.gaps.length, fs.chain.length - 1);
  }
  assert.ok(extra > 0);
  // The harness re-measures the same gaps through the cell graph.
  const r = checkFlames(w, 0, 4);
  assert.deepEqual(r.errors, []);
  assert.ok(r.gaps.every((g) => g <= limit));
});

test('the midpoint index is the first at or past half the total', () => {
  assert.equal(midpointIndex([0, 500, 1000, 1943, 2943], 2943), 3);
  assert.equal(midpointIndex([0, 1000, 2000], 2000), 1);
  assert.equal(midpointIndex([0, 500, 1500], 1500), 2);
});

test('a split gap gets its flame at the first path cell at or past half the walk', () => {
  // One below the largest gap of route band 0: that gap splits once, every other gap stays.
  const limit = Math.max(...createWorld('00000000').bandFlames(0, 0).gaps) - 1;
  const w = createWorld('00000000', { gapLimitMs: limit });
  const fs = w.bandFlames(0, 0);
  const walk = walkRoute(w, 0, 1);
  const shape = bandShape(w, walk.at(0));
  const span = [...shape.route.map((i) => shape.boards[i]), walk.at(1).entry.board];
  let checked = 0;
  fs.chain.forEach((m, i) => {
    if (m.kind !== 'gap') return;
    const A = fs.chain[i - 1], B = fs.chain[i + 1];
    const total = walkMs(w, span, A, B), tm = walkMs(w, span, A, m);
    assert.equal(tm + walkMs(w, span, m, B), total, 'the flame lies on the path');
    let before = null;
    const bm = w.board(m.x, m.y);
    for (let d = 0; d < 8; d++) {
      const n = w.step(bm, m.cell, d);
      if (!n) continue;
      const tn = walkMs(w, span, A, { x: n.board.x, y: n.board.y, cell: n.cell });
      if (tn + COST[d] === tm) before = tn;
    }
    assert.notEqual(before, null, 'the path cell before the flame exists');
    assert.ok(2 * tm >= total, `flame at ${tm} ms of ${total} ms sits before the midpoint`);
    assert.ok(2 * before < total, `cell before the flame at ${before} ms of ${total} ms is already past the midpoint`);
    checked++;
  });
  assert.ok(checked >= 1);
});

/** The growTree tree of attempt k of board (x, y), with its primary pair. */
function attempt(x, y, k) {
  const bd = createWorld('00000000').board(x, y);
  const H = makeHasher(worldKey('00000000'));
  const cell = (dir) => bd.doors.find((d) => d.dir === dir).cell;
  const isDoor = new Uint8Array(NCELL);
  for (const d of bd.doors) isDoor[d.cell] = 1;
  const links = growTree(sfc32(H('board', x, y, k)), new Uint8Array(NCELL));
  return { bd, links, isDoor, a: cell(bd.aDir), b: bd.bDir >= 0 ? cell(bd.bDir) : -1 };
}

test('the repair brings a tree that misses the targets to a spanning tree that meets them', () => {
  // Two route boards of band (0, 0).
  for (const [x, y] of [[0, 1], [1, 1]]) {
    const { bd, links, isDoor, a, b } = attempt(x, y, 0);
    assert.equal(bd.kind, 'route');
    const doorCells = bd.doors.map((d) => d.cell);
    assert.ok(!measureTargets(links, a, b, doorCells).ok, `(${x},${y}) attempt 0 meets the targets before the repair`);
    const r = repairTree(links, a, b, isDoor);
    assert.equal(r.deficit, 0);
    assert.equal(analyze(links, a, b, isDoor).deficit, 0);
    assert.ok(measureTargets(links, a, b, doorCells).ok, `(${x},${y}) repaired tree misses the targets`);
    // Spanning: every link has its mirror, 83 links join all 84 cells.
    let ends = 0;
    const seen = new Set([a]), queue = [a];
    for (let h = 0; h < queue.length; h++) {
      for (let d = 0; d < 8; d++) {
        if (!(links[queue[h]] & (1 << d))) continue;
        const t = queue[h] + DY[d] * 12 + DX[d];
        assert.ok(links[t] & (1 << (d ^ 2)), `one-sided link ${queue[h]}->${t}`);
        if (!seen.has(t)) { seen.add(t); queue.push(t); }
        ends++;
      }
    }
    assert.equal(seen.size, NCELL);
    assert.equal(ends, 2 * (NCELL - 1));
    // Each gallery's block holds no other link and no cell joins two blocks.
    const owner = new Map();
    for (let c = 0; c < NCELL; c++) {
      for (const d of [4, 5]) {
        if (!(links[c] & (1 << d))) continue;
        const a0 = c - (d === 5 ? 1 : 0), block = [a0, a0 + 1, a0 + 12, a0 + 13];
        let inBlock = 0;
        for (const u of block) {
          for (let e = 0; e < 8; e++) if (links[u] & (1 << e) && block.includes(u + DY[e] * 12 + DX[e])) inBlock++;
          assert.ok(!owner.has(u), `cell ${u} lies in two blocks`);
          owner.set(u, c);
        }
        assert.equal(inBlock, 2, `gallery ${c} shares its block`);
      }
    }
    assert.ok(owner.size > 0);
  }
});
