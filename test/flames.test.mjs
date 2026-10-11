import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardCoords } from '../src/world/world.mjs';
import { NCELL } from '../src/world/board.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { u32 } from '../src/world/hash.mjs';
import { worlds } from './sample.mjs';

// The oracle holds its own copy of the rule: literal costs, the literal 20 s
// and its own walk over `world.step`, never the module's constants.
const COST = [500, 1000, 500, 1000, 943, 943, 943, 943];
const LIMIT_MS = 20000;
const key = (x, y, cell) => `${x},${y},${cell}`;
const flameCell = (world, x, y) => u32(world.H('flame', x, y), 4) % NCELL;

/** Cells within LIMIT_MS of walking from (bd, cell), keyed to their board, cell and time. */
function reach(world, bd, cell) {
  const best = new Map([[key(bd.x, bd.y, cell), { bd, cell, ms: 0 }]]);
  const stack = [best.get(key(bd.x, bd.y, cell))];
  while (stack.length) {
    const at = stack.pop();
    for (let d = 0; d < 8; d++) {
      const n = world.step(at.bd, at.cell, d);
      if (!n) continue;
      const ms = at.ms + COST[d];
      const k = key(n.board.x, n.board.y, n.cell);
      if (ms > LIMIT_MS || (best.has(k) && best.get(k).ms <= ms)) continue;
      const to = { bd: n.board, cell: n.cell, ms };
      best.set(k, to);
      stack.push(to);
    }
  }
  return best;
}

/** Whether the reach holds a flame of `keys` or an entry board's flame cell, other than the start. */
function near(world, start, keys) {
  const hits = [];
  for (const [k, r] of reach(world, ...start)) {
    if (k === key(start[0].x, start[0].y, start[1])) continue;
    if (keys.has(k) || (r.bd.entry && r.cell === flameCell(world, r.bd.x, r.bd.y))) hits.push(r);
  }
  return hits;
}

/** The test's own candidates of tomb (u, v), in the keep order: route, then dead end. */
function candidates(world, u, v) {
  const t = world.tomb(u, v);
  const at = (i) => { const { x, y } = boardCoords(u, v, i, world.size); return world.board(x, y); };
  const out = [];
  for (const route of t.routes) {
    route.forEach((i, j) => {
      if (j % 3 === 0 && !t.entries.includes(i)) {
        const bd = at(i);
        out.push({ bd, cell: flameCell(world, bd.x, bd.y), kind: 'route' });
      }
    });
  }
  for (let i = 0; i < t.depth.length; i++) {
    const bd = t.depth[i] > 0 ? at(i) : null;
    if (bd && world.H('flame', bd.x, bd.y)[0] < 128) out.push({ bd, cell: bd.b, kind: 'dead' });
  }
  const entries = [...new Set(t.entries)].map((i) => {
    const bd = at(i);
    return { bd, cell: flameCell(world, bd.x, bd.y), kind: 'entry' };
  });
  return { entries, out };
}

/** Flames of tomb (u, v) that are not gap flames, as keys by kind. */
function placed(world, u, v) {
  const fs = world.tombFlames(u, v).flames.filter((f) => f.kind !== 'gap');
  return fs.map((f) => ({ ...f, k: key(f.x, f.y, f.cell) }));
}

function* tombs() {
  for (let v = 0; v <= 19; v++) for (let u = -2; u <= 2; u++) yield [u, v];
}

for (const d of DIFFICULTIES) {
  const world = worlds[d];

  test(`${d}: no route or dead-end flame stands within 20 s of another kept flame or an entry flame`, () => {
    for (const [u, v] of tombs()) {
      const fs = placed(world, u, v);
      const keys = new Set(fs.map((f) => f.k));
      for (const f of fs) {
        if (f.kind === 'entry') continue;
        const bd = world.board(f.x, f.y);
        const hits = near(world, [bd, f.cell], keys);
        assert.deepEqual(hits.map((h) => [h.bd.x, h.bd.y, h.cell, h.ms]), [], `tomb (${u},${v}) ${f.kind} flame ${f.k}`);
      }
    }
  });

  test(`${d}: a dropped candidate stands within 20 s of a kept flame or an entry flame`, () => {
    for (const [u, v] of tombs()) {
      const keys = new Set(placed(world, u, v).map((f) => f.k));
      for (const c of candidates(world, u, v).out) {
        if (keys.has(key(c.bd.x, c.bd.y, c.cell))) continue;
        assert.ok(near(world, [c.bd, c.cell], keys).length > 0, `tomb (${u},${v}) dropped ${c.kind} ${key(c.bd.x, c.bd.y, c.cell)}`);
      }
    }
  });

  test(`${d}: a greedy pass in route, then dead-end order reproduces every tomb's flames`, () => {
    for (const [u, v] of tombs()) {
      const { entries, out } = candidates(world, u, v);
      const keys = new Set(entries.map((e) => key(e.bd.x, e.bd.y, e.cell)));
      const want = entries.map((e) => key(e.bd.x, e.bd.y, e.cell));
      for (const c of out) {
        if (near(world, [c.bd, c.cell], keys).length > 0) continue;
        const k = key(c.bd.x, c.bd.y, c.cell);
        keys.add(k);
        want.push(k);
      }
      const got = placed(world, u, v).map((f) => f.k);
      assert.deepEqual(got.sort(), want.sort(), `tomb (${u},${v})`);
      for (const e of entries) assert.ok(got.includes(key(e.bd.x, e.bd.y, e.cell)), `tomb (${u},${v}) entry burns`);
    }
  });
}

test('flames per tomb and dropped candidates by level', () => {
  const perTomb = { easy: '1.82', medium: '3.62', hard: '6.29', ultimate: '9.29' };
  const dropped = { easy: [13, 4], medium: [18, 4], hard: [17, 10], ultimate: [16, 5] };
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    let flames = 0, route = 0, dead = 0;
    for (const [u, v] of tombs()) {
      const keys = new Set(placed(world, u, v).map((f) => f.k));
      flames += world.tombFlames(u, v).flames.length;
      for (const c of candidates(world, u, v).out) {
        if (keys.has(key(c.bd.x, c.bd.y, c.cell))) continue;
        if (c.kind === 'route') route++;
        else dead++;
      }
    }
    assert.equal((flames / 100).toFixed(2), perTomb[d], d);
    assert.deepEqual([route, dead], dropped[d], d);
  }
});

test('MEDIUM tomb (-2, 1) loses its route flame at board (-6, 5) cell 38, 17.9 s from the entry flame at (-6, 6) cell 68', () => {
  const world = worlds.medium;
  assert.equal(world.tombFlames(-2, 1).flames.some((f) => f.x === -6 && f.y === 5 && f.cell === 38), false);
  const at = reach(world, world.board(-6, 5), 38).get(key(-6, 6, 68));
  assert.ok(at && at.ms >= 17850 && at.ms <= 17950, `${at?.ms}`);
});
