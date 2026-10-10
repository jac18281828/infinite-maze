import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, digestBands, serializeBoard, posOf, bandOf, midpointIndex } from '../src/world/world.mjs';
import { COST, DX, DY, NCELL, growTree, repairTree, analyze } from '../src/world/board.mjs';
import { parseCode, formatCode, codeFromBytes, makeHasher, worldKey, sfc32 } from '../src/world/hash.mjs';
import { encodeSave, decodeSave } from '../src/world/save.mjs';
import { MIN_ROUTE, MAX_DEPTH } from '../src/world/band.mjs';
import { checkFlames, checkDeterminism, bandShape, walkMs, measureTargets } from '../tools/acceptance.mjs';

// Pinned digest of bands 0..99 for seed code 0000-0000.
const DIGEST = 'a4cdd32a1e141af34b729c22d50d8ee4c6d1260717c52863b75ad239c4589b42';

test('seed 0000-0000 yields the pinned digest over bands 0..99', () => {
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

test('saves round-trip, negative p included', () => {
  for (const [x, y] of [[0, 0], [5, 3], [2, -1], [0, -4000], [4, 999999], [3, -7]]) {
    const text = encodeSave('K7Q2M9XA', x, y);
    assert.match(text, /^K7Q2-M9XA:-?\d+$/);
    const back = decodeSave(text);
    assert.deepEqual(back, { code: 'K7Q2M9XA', p: posOf(x, y), x, y });
  }
  assert.equal(encodeSave('K7Q2M9XA', 2, -1), 'K7Q2-M9XA:-4');
  assert.deepEqual(decodeSave('k7q2m9xa:4813'), { code: 'K7Q2M9XA', p: 4813, x: 1, y: 802 });
  assert.equal(decodeSave('K7Q2-M9XA'), null);
  assert.equal(decodeSave('K7Q2-M9XA:1.5'), null);
  assert.equal(decodeSave('K7Q2-M9XU:3'), null);
});

test('a board resumed from p equals the same board generated in sequence', () => {
  const seq = createWorld('00000000');
  for (let b = -3; b <= 3; b++) {
    for (let i = 0; i < 24; i++) seq.board(i % 6, 4 * b + Math.floor(i / 6));
    seq.bandFlames(b);
  }
  for (const p of [posOf(seq.tree(-2).entryX, -8), posOf(1, -3), posOf(seq.tree(0).entryX, 0), posOf(4, 6), posOf(2, 13)]) {
    const fresh = createWorld('00000000');
    const y = Math.floor(p / 6), x = p - 6 * y;
    assert.deepEqual(serializeBoard(fresh, x, y), serializeBoard(seq, x, y), `p=${p}`);
  }
});

test('a resume lands on the door leading back toward the band entry', () => {
  const w = createWorld('00000000');
  const t = w.tree(5);
  const entry = w.resumePoint(t.entryX, 20);
  assert.equal(entry.cell, entry.board.doors.find((d) => d.dir === 3).cell);
  const second = t.route[1];
  const r = w.resumePoint(second % 6, 20 + Math.floor(second / 6));
  assert.equal(r.cell, r.board.a);
  const rock = t.depth.findIndex((d) => d < 0);
  if (rock >= 0) assert.equal(w.resumePoint(rock % 6, 20 + Math.floor(rock / 6)).board.p, posOf(t.entryX, 20));
});

test('band trees keep a route of 12+ boards and dead ends at most 2 deep', () => {
  const w = createWorld('00000000');
  for (let b = -40; b <= 40; b++) {
    const t = w.tree(b);
    assert.ok(t.route.length >= MIN_ROUTE);
    assert.ok(Math.max(...t.depth) <= MAX_DEPTH);
    assert.equal(t.route[0], t.entryX);
    assert.equal(t.route.at(-1), 18 + w.tree(b + 1).entryX);
    const shape = bandShape(w, b);
    assert.deepEqual(shape.route, t.route, `band ${b}`);
  }
});

test('bandOf floors toward negative infinity', () => {
  assert.equal(bandOf(-1), -1);
  assert.equal(bandOf(-4), -1);
  assert.equal(bandOf(-5), -2);
  assert.equal(bandOf(3), 0);
});

test('gap splitting adds midpoint flames until every gap fits the limit', () => {
  const limit = 20000;
  const w = createWorld('00000000', { gapLimitMs: limit });
  let extra = 0;
  for (let b = 0; b <= 4; b++) {
    const fs = w.bandFlames(b);
    extra += fs.flames.filter((f) => f.kind === 'gap').length;
    assert.ok(fs.gaps.every((g) => g <= limit), `band ${b}`);
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
  const b = 0;
  // One below the largest gap: that gap splits once, every other gap stays.
  const limit = Math.max(...createWorld('00000000').bandFlames(b).gaps) - 1;
  const w = createWorld('00000000', { gapLimitMs: limit });
  const fs = w.bandFlames(b);
  const shape = bandShape(w, b), next = bandShape(w, b + 1);
  const span = [...shape.route.map((i) => shape.boards[i]), next.entry];
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

/** The growTree tree of attempt k of board (x, y) in band 0, with its primary pair. */
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
  for (const [x, y] of [[0, 1], [2, 1]]) {
    const { bd, links, isDoor, a, b } = attempt(x, y, 0);
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
