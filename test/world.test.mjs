import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createWorld, digestTombs, serializeBoard, posOf, boardOfPos, tombOf, boardCoords, midpointIndex, SAVE_LIMIT,
} from '../src/world/world.mjs';
import { COST, DX, DY, NCELL, growTree, repairTree, analyze, flameCell } from '../src/world/board.mjs';
import { parseCode, formatCode, codeFromBytes, makeHasher, worldKey, sfc32 } from '../src/world/hash.mjs';
import { encodeSave, decodeSave } from '../src/world/save.mjs';
import { DIFFICULTY, DIFFICULTIES, minRoute } from '../src/world/band.mjs';
import { createFlow, exitDir, wallRight, UP, LEFT, RIGHT } from '../src/world/flow.mjs';
import {
  checkFlames, checkFlow, checkTree, checkBounds, checkDeterminism, tombShape, tombWindow, entrySpan, walkMs,
  measureTargets, runChecks, checkWayUp, explorationMs, WAY_UP_CAP,
} from '../tools/acceptance.mjs';

// Pinned digests of tombs u in [-2, 2], v in [0, 19] for seed code 0000-0000.
const DIGESTS = {
  easy: 'f513618db7cc689234a6c1e9443debcf1b8bd9225b6d16cb9d4b240303001381',
  medium: '287bb293641a9a36280a8afe05918a0f1f53de67bc511ba0ad2569d9d9830049',
  hard: '53b8582e503a203b7d9de0eb28198ba192e75de773357b3c5d00b4f40331fc93',
  ultimate: '91801ad980eddd92b08379f4e895fba9abc1d0c89f8f39b8fb89d31f77d83b5d',
};
// Each level's dead-end depth and path target, restated apart from the generator.
const DEPTH = { easy: 1, medium: 2, hard: 2, ultimate: 2 };
const PATH = { easy: 16, medium: 22, hard: 22, ultimate: 22 };
const world = createWorld('00000000');
const DEFAULT = tombWindow(-10, 10, -50, 50);
const worlds = Object.fromEntries(DIFFICULTIES.map((d) => [d, createWorld('00000000', { difficulty: d })]));

test('seed 0000-0000 yields the pinned digest of tombs u -2..2, v 0..19 at each difficulty', () => {
  for (const d of DIFFICULTIES) {
    const w = createWorld('00000000', { difficulty: d });
    assert.equal(w.difficulty, d);
    assert.deepEqual(w.size, DIFFICULTY[d]);
    assert.equal(digestTombs(w, -2, 2, 0, 19), DIGESTS[d], d);
    assert.deepEqual(checkDeterminism('00000000', DIGESTS[d], d).errors, [], d);
  }
  assert.equal(new Set(Object.values(DIGESTS)).size, 4);
  assert.deepEqual(DIFFICULTY, { easy: { w: 2, h: 2 }, medium: { w: 3, h: 3 }, hard: { w: 4, h: 4 }, ultimate: { w: 6, h: 4 } });
  assert.deepEqual(DIFFICULTIES, ['easy', 'medium', 'hard', 'ultimate']);
});

test('ULTIMATE, the original 6x4 world, is the default', () => {
  const plain = createWorld('00000000');
  assert.equal(plain.difficulty, 'ultimate');
  assert.deepEqual(plain.size, { w: 6, h: 4 });
  assert.equal(digestTombs(plain, -2, 2, 0, 19), DIGESTS.ultimate);
});

test('exploring a room fully and walking back takes 57.086 s at EASY, 64.328 s at MEDIUM, 71.830 s at HARD and 71.762 s at ULTIMATE', () => {
  const win = tombWindow(-2, 2, 0, 19);
  const want = { easy: '57.086', medium: '64.328', hard: '71.830', ultimate: '71.762' };
  for (const d of DIFFICULTIES) assert.equal((explorationMs(worlds[d], win) / 1000).toFixed(3), want[d], d);
});

test('an unknown difficulty throws', () => {
  assert.throws(() => createWorld('00000000', { difficulty: 'nightmare' }), /unknown difficulty/);
  assert.throws(() => createWorld('00000000', { difficulty: 'toString' }), /unknown difficulty/);
});

test('every level is a plane: EASY, MEDIUM and HARD pass every check over the default window', () => {
  for (const d of ['easy', 'medium', 'hard']) {
    for (const [name, r] of runChecks(createWorld('00000000', { difficulty: d }), '00000000', DEFAULT).rows) {
      assert.deepEqual(r.errors, [], `${d} ${name}`);
    }
  }
});

test('a tomb\'s boards lie in [Wu, Wu + W) x [Hv, Hv + H), and its doors cross inside its size', () => {
  for (const d of DIFFICULTIES) {
    const w = worlds[d], { w: W, h: H } = w.size;
    let doors = 0;
    for (let v = -4; v <= 4; v++) {
      for (let u = -4; u <= 4; u++) {
        for (let i = 0; i < W * H; i++) {
          const { x, y } = boardCoords(u, v, i, w.size);
          assert.ok(x >= W * u && x < W * u + W && y >= H * v && y < H * v + H, `${d} tomb (${u},${v}) board ${i}`);
          assert.deepEqual(tombOf(x, y, w.size), { u, v });
          const bd = w.board(x, y);
          assert.deepEqual([bd.u, bd.v, bd.index], [u, v, i]);
        }
        // A floor or ceiling door crosses at a column of the tomb, a side door at one of its rows.
        const t = w.tomb(u, v);
        for (const wl of t.walls) {
          const col = wl.i % W, row = Math.floor(wl.i / W);
          assert.ok(wl.i >= 0 && wl.i < W * H, `${d} tomb (${u},${v}) door board ${wl.i}`);
          assert.ok([col === W - 1, row === H - 1, col === 0, row === 0][wl.dir], `${d} tomb (${u},${v}) door ${wl.dir} off its wall`);
          doors++;
        }
        const key = (wl) => `${wl.dir}:${wl.i}`;
        assert.deepEqual(new Set(tombShape(w, u, v).walls.map(key)), new Set(t.walls.map(key)), `${d} tomb (${u},${v})`);
      }
    }
    assert.ok(doors > 81, d);
  }
});

test('the flow is the same at every level: walls, exits and in-doors agree over the default window', () => {
  const at = (w, u, v) => {
    const t = w.tomb(u, v);
    return [t.exit, ...t.walls.slice(1).map((wl) => wl.dir)].join(',');
  };
  let sides = 0;
  for (let v = DEFAULT.v0; v <= DEFAULT.v1; v++) {
    for (let u = DEFAULT.u0; u <= DEFAULT.u1; u++) {
      const hard = at(worlds.hard, u, v);
      assert.equal(at(worlds.easy, u, v), hard, `tomb (${u},${v}) at EASY`);
      assert.equal(at(worlds.medium, u, v), hard, `tomb (${u},${v}) at MEDIUM`);
      assert.equal(at(worlds.ultimate, u, v), hard, `tomb (${u},${v}) at ULTIMATE`);
      if (worlds.hard.tomb(u, v).exit !== UP) sides++;
    }
  }
  assert.ok(sides > 0);
  // The doors show the same walls at every level.
  for (let v = -3; v <= 3; v++) {
    for (let u = -3; u <= 3; u++) {
      const walls = DIFFICULTIES.map((d) => {
        const s = tombShape(worlds[d], u, v);
        return [s.exit, ...[...new Set(s.walls.map((wl) => wl.dir))].sort()].join(',');
      });
      assert.equal(new Set(walls).size, 1, `tomb (${u},${v}): ${walls.join(' | ')}`);
    }
  }
});

test('a different seed yields a different digest', () => {
  assert.notEqual(digestTombs(createWorld('K7Q2M9XA'), 0, 0, 0, 3), digestTombs(createWorld('00000000'), 0, 0, 0, 3));
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

test('saves round-trip for negative and mixed-sign boards', () => {
  const edge = SAVE_LIMIT - 1;
  for (const [x, y] of [[0, 0], [5, 3], [-2, -1], [-7, 4000], [4, -999999], [-6, 0], [edge, -edge], [-edge, edge]]) {
    const text = encodeSave('K7Q2M9XA', x, y);
    assert.match(text, /^K7Q2-M9XA:\d+$/);
    assert.ok(text.length <= 26, text);
    const back = decodeSave(text);
    assert.deepEqual(back, { code: 'K7Q2M9XA', p: posOf(x, y), x, y });
  }
  assert.equal(encodeSave('K7Q2M9XA', -edge, -edge).length, 26);
  // The pairing is one-to-one over a block of signed boards.
  const seen = new Set();
  for (let x = -20; x <= 20; x++) {
    for (let y = -20; y <= 20; y++) {
      const p = posOf(x, y);
      assert.ok(!seen.has(p));
      seen.add(p);
      assert.deepEqual(boardOfPos(p), { x, y });
    }
  }
  assert.deepEqual(decodeSave('k7q2m9xa:13'), { code: 'K7Q2M9XA', p: 13, ...boardOfPos(13) });
  assert.equal(decodeSave('K7Q2-M9XA'), null);
  assert.equal(decodeSave('K7Q2-M9XA:1.5'), null);
  assert.equal(decodeSave('K7Q2-M9XA:-4'), null);
  assert.equal(decodeSave('K7Q2-M9XU:3'), null);
});

test('at each difficulty a board resumed from p equals the same board reached along the routes', () => {
  for (const d of DIFFICULTIES) {
    const seq = createWorld('00000000', { difficulty: d });
    const n = seq.size.w * seq.size.h;
    const ps = [];
    // Along the routes, tomb by tomb, then each tomb's other boards.
    for (let v = -2; v <= 2; v++) {
      for (let u = -2; u <= 2; u++) {
        const t = seq.tomb(u, v);
        for (const route of t.routes) {
          for (const i of route) {
            const { x, y } = boardCoords(u, v, i, seq.size);
            ps.push(seq.board(x, y).p);
          }
        }
        seq.tombFlames(u, v);
        for (let i = 0; i < n; i++) {
          const { x, y } = boardCoords(u, v, i, seq.size);
          if (!ps.includes(posOf(x, y))) ps.push(posOf(x, y));
        }
      }
    }
    for (const p of ps.filter((_, k) => k % 3 === 0)) {
      const save = decodeSave(`0000-0000:${p}`);
      assert.equal(encodeSave('00000000', save.x, save.y), `0000-0000:${p}`);
      assert.equal(seq.board(save.x, save.y).p, p);
      const fresh = createWorld('00000000', { difficulty: d });
      assert.deepEqual(serializeBoard(fresh, save.x, save.y), serializeBoard(seq, save.x, save.y), `${d} p=${p}`);
    }
  }
  // One p names one board, which belongs to a different tomb at each level.
  const at = decodeSave(`0000-0000:${posOf(4, 3)}`);
  assert.deepEqual([at.x, at.y], [4, 3]);
  assert.deepEqual(DIFFICULTIES.map((d) => tombOf(at.x, at.y, DIFFICULTY[d])), [{ u: 2, v: 1 }, { u: 1, v: 1 }, { u: 1, v: 0 }, { u: 0, v: 0 }]);
});

test('saves of boards at or past 2^25 in either axis decode to null', () => {
  for (const [x, y] of [[SAVE_LIMIT, 0], [-SAVE_LIMIT, 0], [0, SAVE_LIMIT], [3, -SAVE_LIMIT], [SAVE_LIMIT, -SAVE_LIMIT]]) {
    assert.equal(decodeSave(encodeSave('K7Q2M9XA', x, y)), null, `(${x}, ${y})`);
  }
});

test('a board resumed from p equals the same board generated in sequence', () => {
  const seq = createWorld('00000000');
  for (let v = -2; v <= 2; v++) {
    for (let u = -2; u <= 2; u++) {
      for (let i = 0; i < seq.size.w * seq.size.h; i++) { const { x, y } = boardCoords(u, v, i, seq.size); seq.board(x, y); }
      seq.tombFlames(u, v);
    }
  }
  const starts = [[-2, -2], [1, -1], [0, 0], [-1, 2], [2, 1]].map(([u, v]) => boardCoords(u, v, seq.tomb(u, v).entries[0], seq.size));
  for (const { x, y } of [...starts, { x: -1, y: -3 }, { x: 4, y: 6 }, { x: -9, y: 7 }, { x: 13, y: -5 }]) {
    const p = posOf(x, y);
    const fresh = createWorld('00000000');
    const back = boardOfPos(p);
    assert.deepEqual(serializeBoard(fresh, back.x, back.y), serializeBoard(seq, x, y), `p=${p}`);
  }
});

test('a resume lands on the first primary cell; a rock board resumes at its tomb\'s first entry', () => {
  const w = createWorld('00000000');
  let entries = 0, sources = 0, rocks = 0;
  for (let v = 0; v <= 6; v++) {
    for (let u = -3; u <= 3; u++) {
      const t = w.tomb(u, v);
      const e = boardCoords(u, v, t.entries[0], w.size);
      const r = w.resumePoint(e.x, e.y);
      if (t.source) {
        assert.equal(r.cell, flameCell(w.H, e.x, e.y));
        sources++;
      } else {
        const wall = t.walls[1].dir;
        assert.equal(r.cell, r.board.doors.find((d) => d.dir === wall).cell);
        entries++;
      }
      const second = t.routes[0][1];
      if (second !== undefined) {
        const b = boardCoords(u, v, second, w.size);
        assert.equal(w.resumePoint(b.x, b.y).cell, w.board(b.x, b.y).a);
      }
      const rock = t.depth.findIndex((d) => d < 0);
      if (rock >= 0) {
        const b = boardCoords(u, v, rock, w.size);
        assert.equal(w.resumePoint(b.x, b.y).board.p, posOf(e.x, e.y));
        rocks++;
      }
    }
  }
  assert.ok(entries > 0 && sources > 0 && rocks > 0);
  const start = w.startPoint();
  const t0 = w.tomb(0, 0);
  assert.equal(start.board.p, posOf(...Object.values(boardCoords(0, 0, t0.entries[0], w.size))));
  assert.equal(start.cell, start.board.a);
});

test('tomb trees keep a trunk of half their boards or more, dead ends at most the level\'s depth, and match their doors', () => {
  const rooms = {};
  for (const d of DIFFICULTIES) {
    const w = worlds[d], min = minRoute(w.size);
    const deep = rooms[d] = [0, 0, 0];
    for (let v = -12; v <= 12; v++) {
      for (let u = -4; u <= 4; u++) {
        const t = w.tomb(u, v);
        const at = `${d} tomb (${u},${v})`;
        assert.ok(t.routes[0].length >= min || t.entries[0] === t.X, at);
        assert.ok(Math.max(...t.depth) <= DEPTH[d], at);
        for (const k of t.depth) if (k > 0) deep[Math.min(k, 2)]++;
        assert.equal(t.routes[0][0], t.entries[0], at);
        assert.equal(t.routes[0].at(-1), t.X, at);
        assert.notEqual(t.exit, 3, at);
        const shape = tombShape(w, u, v);
        assert.deepEqual(shape.errors, [], at);
        assert.equal(shape.exit, t.exit, at);
        assert.deepEqual(shape.entries, t.entries, at);
        assert.deepEqual(shape.routes, t.routes, at);
      }
    }
    assert.ok(rooms[d][1] > 0, `${d} holds depth-1 rooms`);
    if (DEPTH[d] < 2) assert.equal(rooms[d][2], 0, `${d}: ${rooms[d][2]} rooms at depth 2`);
  }
  // EASY's dead ends are one room deep; MEDIUM's reach two.
  assert.deepEqual(rooms.easy, [0, 228, 0]);
  assert.equal(rooms.medium[2], 168);
});

test('tombOf floors toward negative infinity on both axes at each tomb size', () => {
  const ultimate = DIFFICULTY.ultimate, hard = DIFFICULTY.hard, easy = DIFFICULTY.easy;
  assert.deepEqual(tombOf(-1, -1, ultimate), { u: -1, v: -1 });
  assert.deepEqual(tombOf(-6, -4, ultimate), { u: -1, v: -1 });
  assert.deepEqual(tombOf(-7, -5, ultimate), { u: -2, v: -2 });
  assert.deepEqual(tombOf(5, 3, ultimate), { u: 0, v: 0 });
  assert.deepEqual(tombOf(6, 4, ultimate), { u: 1, v: 1 });
  assert.deepEqual(tombOf(3, 3, hard), { u: 0, v: 0 });
  assert.deepEqual(tombOf(-4, -5, hard), { u: -1, v: -2 });
  assert.deepEqual(tombOf(3, 2, easy), { u: 1, v: 1 });
  assert.deepEqual(tombOf(-1, -1, easy), { u: -1, v: -1 });
  assert.deepEqual(tombOf(-4, -3, easy), { u: -2, v: -2 });
  assert.deepEqual(tombOf(3, 3, DIFFICULTY.medium), { u: 1, v: 1 });
});

test('a tomb exits up, or through the side its walls open, and never down', () => {
  const H = makeHasher(worldKey('00000000'));
  const flow = createFlow(H, DIFFICULTY.hard);
  let sides = 0;
  for (let v = -20; v <= 20; v++) {
    for (let u = -20; u <= 20; u++) {
      const e = flow.exit(u, v);
      assert.equal(e, exitDir(H, u, v));
      if (e === RIGHT) assert.ok(wallRight(H, u, v));
      if (e === LEFT) assert.ok(!wallRight(H, u - 1, v));
      if (e !== UP) sides++;
      assert.ok(!(e === RIGHT && flow.exit(u + 1, v) === LEFT));
      assert.ok([UP, LEFT, RIGHT].includes(e));
    }
  }
  assert.ok(sides > 0);
});

test('over the default window, flow passes and at least 10% of exits go each way sideways', () => {
  // Stacked bands exit up every time, so this fails on a revert.
  const r = checkFlow(world, DEFAULT);
  assert.deepEqual(r.errors, []);
  assert.equal(r.tombs, 2121);
  assert.ok(r.left >= 0.1, `left ${r.left}`);
  assert.ok(r.right >= 0.1, `right ${r.right}`);
});

test('over the default window, every way on climbs out within the cap, and the merge figures are reported', () => {
  const r = checkWayUp(world, DEFAULT);
  assert.deepEqual(r.errors, []);
  assert.equal(r.tombs, 2121);
  assert.equal(r.cap, WAY_UP_CAP);
  assert.ok(r.climbMax > 0 && r.climbMax <= WAY_UP_CAP, `climb ${r.climbMax}`);
  assert.ok(r.meetShare > 0 && r.meetShare <= 1, `meet ${r.meetShare}`);
  assert.ok(r.meetMean <= r.meetMax, `mean ${r.meetMean} max ${r.meetMax}`);
});

test('the ways on from tombs (0, 0) and (10, -50) are 15 columns apart at row 0', () => {
  // SPEC section 1: they first meet at row 773,851.
  let u = 10, v = -50;
  while (v < 0) {
    const d = world.exit(u, v);
    u += [1, 0, -1, 0][d];
    v += [0, 1, 0, -1][d];
  }
  assert.equal(u, 15);
});

/** First tomb from v 0 upward, u -10..10, whose tree passes `pred`. */
function findTomb(pred) {
  for (let v = 0; v <= 200; v++) {
    for (let u = -10; u <= 10; u++) if (pred(world.tomb(u, v))) return world.tomb(u, v);
  }
  throw new Error('no tomb matches');
}

/** Tree, bounds and flames pass on tomb t, and its doors join every entry to its exit. */
function soundTomb(t) {
  const win = tombWindow(t.u, t.u, t.v, t.v);
  assert.deepEqual(checkTree(world, win).errors, []);
  assert.deepEqual(checkBounds(world, win).errors, []);
  const r = checkFlames(world, win);
  assert.deepEqual(r.errors, []);
  assert.ok(r.gaps.every((g) => g <= 150000));
  const fs = world.tombFlames(t.u, t.v);
  assert.equal(fs.chains.length, t.entries.length);
  const shape = tombShape(world, t.u, t.v);
  for (let j = 0; j < t.entries.length; j++) assert.ok(entrySpan(world, shape, j).length >= 2, `entry ${j + 1} reaches the exit`);
  return fs;
}

test('a tomb with three in-doors joins them all, a tributary included, and every chain keeps gaps to 150 s', () => {
  const t = findTomb((q) => q.walls.length === 4 && q.routes.length >= 2);
  assert.equal(t.entries.length, 3);
  assert.deepEqual(t.walls.slice(1).map((w) => w.dir), [3, 2, 0]);
  const fs = soundTomb(t);
  // Every entry holds a flame at its flame cell, and its chain starts there.
  fs.chains.forEach((chain, j) => {
    const e = boardCoords(t.u, t.v, t.entries[j], world.size);
    assert.deepEqual([chain[0].x, chain[0].y, chain[0].cell], [e.x, e.y, flameCell(world.H, e.x, e.y)]);
  });
});

test('a source tomb starts its trunk at S and builds a tree that keeps gaps to 150 s', () => {
  const t = findTomb((q) => q.source);
  assert.equal(t.entries.length, 1);
  assert.equal(t.walls.length, 1);
  soundTomb(t);
  const s = boardCoords(t.u, t.v, t.entries[0], world.size);
  const bd = world.board(s.x, s.y);
  assert.equal(bd.a, flameCell(world.H, s.x, s.y));
  assert.equal(bd.aDir, -1);
});

test('a tomb whose first entry board is its exit board builds a one-board trunk with dead ends', () => {
  const t = findTomb((q) => q.entries[0] === q.X);
  assert.deepEqual(t.routes[0], [t.X]);
  assert.ok(t.depth.some((d) => d > 0), 'dead ends hang off the trunk');
  soundTomb(t);
});

test('a board whose primary pair meets in one cell measures to its deepest cell', () => {
  // S's flame cell is the door it leaves by: S is X in EASY tomb (0, -149) and
  // ULTIMATE tomb (3, 28), and leads on along the trunk in EASY tomb (0, -2).
  for (const [d, u, v, sIsX] of [['easy', 0, -149, true], ['easy', 0, -2, false], ['ultimate', 3, 28, true]]) {
    const w = worlds[d], t = w.tomb(u, v), at = `${d} tomb (${u},${v})`;
    assert.ok(t.source, at);
    assert.equal(t.entries[0] === t.X, sIsX, at);
    const { x, y } = boardCoords(u, v, t.entries[0], w.size);
    const bd = w.board(x, y);
    assert.equal(bd.a, flameCell(w.H, x, y), at);
    assert.equal(bd.a, bd.doors.find((dr) => dr.dir === bd.bDir).cell, `${at}: the pair meets in one cell`);
    assert.notEqual(bd.b, bd.a, at);
    assert.ok(!bd.fallback && bd.pathLen >= PATH[d], `${at} meets the targets`);
    assert.deepEqual(checkBounds(w, tombWindow(u, u, v, v)).errors, [], at);
  }
});

test('gap splitting adds midpoint flames until every gap fits the limit', () => {
  const limit = 20000;
  const w = createWorld('00000000', { gapLimitMs: limit });
  let extra = 0;
  for (let v = 0; v <= 2; v++) {
    for (let u = -1; u <= 1; u++) {
      const fs = w.tombFlames(u, v);
      extra += fs.flames.filter((f) => f.kind === 'gap').length;
      assert.ok(fs.gaps.every((g) => g <= limit), `tomb (${u},${v})`);
      assert.equal(fs.gaps.length, fs.chains.reduce((n, c) => n + c.length - 1, 0));
    }
  }
  assert.ok(extra > 0);
  // The harness re-measures the same gaps through the cell graph.
  const r = checkFlames(w, tombWindow(-1, 1, 0, 2));
  assert.deepEqual(r.errors, []);
  assert.ok(r.gaps.every((g) => g <= limit));
});

test('the midpoint index is the first at or past half the total', () => {
  assert.equal(midpointIndex([0, 500, 1000, 1943, 2943], 2943), 3);
  assert.equal(midpointIndex([0, 1000, 2000], 2000), 1);
  assert.equal(midpointIndex([0, 500, 1500], 1500), 2);
});

test('a split gap gets its flame at the first path cell at or past half the walk', () => {
  const u = 0, v = 0;
  // One below the largest gap: that gap splits once, every other gap stays.
  const limit = Math.max(...createWorld('00000000').tombFlames(u, v).gaps) - 1;
  const w = createWorld('00000000', { gapLimitMs: limit });
  const fs = w.tombFlames(u, v);
  const shape = tombShape(w, u, v);
  let checked = 0;
  fs.chains.forEach((chain, j) => {
    const span = entrySpan(w, shape, j);
    chain.forEach((m, i) => {
      if (m.kind !== 'gap') return;
      const A = chain[i - 1], B = chain[i + 1];
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
  });
  assert.ok(checked >= 1);
});

/** The growTree tree of attempt k of board (x, y) in tomb (0, 0), with its primary pair. */
function attempt(x, y, k) {
  const bd = createWorld('00000000').board(x, y);
  const H = makeHasher(worldKey('00000000'));
  const cell = (dir) => bd.doors.find((d) => d.dir === dir).cell;
  assert.ok(bd.aDir >= 0, `(${x},${y}) enters by a door`);
  const isDoor = new Uint8Array(NCELL);
  for (const d of bd.doors) isDoor[d.cell] = 1;
  const links = growTree(sfc32(H('board', x, y, k)), new Uint8Array(NCELL));
  return { bd, links, isDoor, a: cell(bd.aDir), b: bd.bDir >= 0 ? cell(bd.bDir) : -1 };
}

test('the repair brings a tree that misses the targets to a spanning tree that meets them', () => {
  for (const [x, y] of [[5, 1], [3, 2]]) {
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

// Without the throw the backtrack never ends and the heap balloons, so the
// call runs in a child with a short timeout and a heap cap.
test('cellPath throws an Error naming both cells when links leave the target unreachable', () => {
  const world = new URL('../src/world/world.mjs', import.meta.url).href;
  const script = `
    import { cellPath } from ${JSON.stringify(world)};
    try {
      cellPath(new Uint8Array(84), 3, 70);
      console.log(JSON.stringify({ threw: false }));
    } catch (e) {
      console.log(JSON.stringify({ threw: true, name: e.name, error: e instanceof Error, message: e.message }));
    }`;
  const run = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 });
  assert.equal(run.error, undefined, `the call returns within 2 s: ${run.error && run.error.message}`);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.threw, true);
  assert.equal(out.name, 'Error');
  assert.equal(out.error, true);
  assert.match(out.message, /\b3\b/, 'names from');
  assert.match(out.message, /\b70\b/, 'names to');
});
