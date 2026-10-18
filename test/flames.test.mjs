import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, boardCoords, tombOf } from '../src/world/world.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';
import { codeFromBytes, u32 } from '../src/world/hash.mjs';
import { worlds } from './sample.mjs';

// The oracle holds its own copy of the rules: literal costs, limits and
// thresholds, and its own walks over `world.step`, never the module's constants.
const COST = [500, 1000, 500, 1000, 943, 943, 943, 943];
const SPACING_MS = 20000;
const GAP_LIMIT_MS = 150000;
// Byte 0 of H("flame", x, y) under 85 (85/256) makes a route's board 0 a candidate.
const FIRST_BOARD_BYTE = 85;
const DEAD_END_BYTE = 128;
// Board directions E N W S.
const BDX = [1, 0, -1, 0];
const BDY = [0, 1, 0, -1];
const key = (x, y, cell) => `${x},${y},${cell}`;
const boardKey = (bd) => `${bd.x},${bd.y}`;
const flameCell = (world, x, y) => u32(world.H('flame', x, y), 4) % 84;
const boardAt = (world, u, v, i) => { const { x, y } = boardCoords(u, v, i, world.size); return world.board(x, y); };
const dirTo = (a, b) => BDX.findIndex((dx, d) => a.x + dx === b.x && a.y + BDY[d] === b.y);

/** Cells within SPACING_MS of walking from (bd, cell), keyed to their board, cell and time. */
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
      if (ms > SPACING_MS || (best.has(k) && best.get(k).ms <= ms)) continue;
      const to = { bd: n.board, cell: n.cell, ms };
      best.set(k, to);
      stack.push(to);
    }
  }
  return best;
}

/** The flames of `keys` within SPACING_MS of the start, other than the start. */
function near(world, start, keys) {
  const hits = [];
  for (const [k, r] of reach(world, ...start)) {
    if (k !== key(start[0].x, start[0].y, start[1]) && keys.has(k)) hits.push(r);
  }
  return hits;
}

/** The test's own candidates of tomb (u, v) in keep order: each route (board 0 by chance, then every third board), then dead ends. */
function candidates(world, u, v) {
  const t = world.tomb(u, v);
  const out = [];
  for (const route of t.routes) {
    route.forEach((i, j) => {
      const bd = boardAt(world, u, v, i);
      if (j > 0 ? j % 3 === 0 : world.H('flame', bd.x, bd.y)[0] < FIRST_BOARD_BYTE) {
        out.push({ bd, cell: flameCell(world, bd.x, bd.y), kind: 'route', first: j === 0 });
      }
    });
  }
  for (let i = 0; i < t.depth.length; i++) {
    const bd = t.depth[i] > 0 ? boardAt(world, u, v, i) : null;
    if (bd && world.H('flame', bd.x, bd.y)[0] < DEAD_END_BYTE) out.push({ bd, cell: bd.b, kind: 'dead' });
  }
  return out;
}

const greedyCache = new Map();
/** The candidates a greedy pass keeps: each unless it stands within SPACING_MS of one already kept. */
function greedy(world, u, v) {
  const id = `${world.code}/${world.difficulty}/${u},${v}`;
  if (!greedyCache.has(id)) {
    const kept = new Set(), out = [];
    for (const c of candidates(world, u, v)) {
      if (near(world, [c.bd, c.cell], kept).length > 0) continue;
      kept.add(key(c.bd.x, c.bd.y, c.cell));
      out.push({ x: c.bd.x, y: c.bd.y, cell: c.cell });
    }
    greedyCache.set(id, out);
  }
  return greedyCache.get(id);
}

/** Flames of tomb (u, v) that are not gap flames, with their keys. */
function placed(world, u, v) {
  return world.tombFlames(u, v).flames.filter((f) => f.kind !== 'gap').map((f) => ({ ...f, k: key(f.x, f.y, f.cell) }));
}

function* tombs() {
  for (let v = 0; v <= 19; v++) for (let u = -2; u <= 2; u++) yield [u, v];
}

for (const d of DIFFICULTIES) {
  test(`P1 ${d}: the start board burns by chance alone, exactly when byte 0 of its flame hash is under 85`, () => {
    let burning = 0, dark = 0;
    for (let i = 0; i < 100; i++) {
      const world = createWorld(codeFromBytes([0, 0, 0, i >> 8, i & 255]), { difficulty: d });
      const { x, y } = boardAt(world, 0, 0, world.tomb(0, 0).entries[0]);
      const lit = world.tombFlames(0, 0).flames.some((f) => f.kind !== 'gap' && f.x === x && f.y === y && f.cell === flameCell(world, x, y));
      const chance = world.H('flame', x, y)[0] < FIRST_BOARD_BYTE;
      assert.equal(lit, chance, `code ${i}: board (${x},${y})`);
      if (chance) burning++; else dark++;
    }
    assert.ok(burning > 0 && dark > 0, `the sample holds both cases (${burning} burning, ${dark} dark)`);
  });

  test(`P1 ${d}: byte 0 of 84 lights the start board and byte 0 of 85 leaves it dark`, () => {
    // The first code found for each byte at the start board; the hash alone picks it, so no board is built to search.
    const found = new Map();
    for (let i = 0; i < 16384 && found.size < 2; i++) {
      const world = createWorld(codeFromBytes([0, 0, 0, i >> 8, i & 255]), { difficulty: d });
      const { x, y } = boardAt(world, 0, 0, world.tomb(0, 0).entries[0]);
      const byte = world.H('flame', x, y)[0];
      if ((byte === 84 || byte === 85) && !found.has(byte)) found.set(byte, { world, x, y });
    }
    assert.equal(found.size, 2, 'the search finds both boundary bytes');
    for (const [byte, { world, x, y }] of found) {
      const lit = world.tombFlames(0, 0).flames.some((f) => f.kind !== 'gap' && f.x === x && f.y === y && f.cell === flameCell(world, x, y));
      assert.equal(lit, byte === 84, `byte ${byte}`);
    }
  });
}

for (const d of DIFFICULTIES) {
  const world = worlds[d];

  test(`P2 ${d}: no kept flame stands within 20 s of another flame its tomb kept`, () => {
    for (const [u, v] of tombs()) {
      const fs = placed(world, u, v);
      const keys = new Set(fs.map((f) => f.k));
      for (const f of fs) {
        const hits = near(world, [world.board(f.x, f.y), f.cell], keys);
        assert.deepEqual(hits.map((h) => [h.bd.x, h.bd.y, h.cell, h.ms]), [], `tomb (${u},${v}) ${f.kind} flame ${f.k}`);
      }
    }
  });

  test(`P2 ${d}: a dropped candidate stands within 20 s of a flame its tomb kept`, () => {
    for (const [u, v] of tombs()) {
      const keys = new Set(placed(world, u, v).map((f) => f.k));
      for (const c of candidates(world, u, v)) {
        if (keys.has(key(c.bd.x, c.bd.y, c.cell))) continue;
        assert.ok(near(world, [c.bd, c.cell], keys).length > 0, `tomb (${u},${v}) dropped ${c.kind} ${key(c.bd.x, c.bd.y, c.cell)}`);
      }
    }
  });

  test(`P2 ${d}: a greedy pass over the route, then dead-end candidates reproduces every tomb's flames`, () => {
    for (const [u, v] of tombs()) {
      const want = greedy(world, u, v).map((f) => key(f.x, f.y, f.cell));
      const got = placed(world, u, v);
      assert.deepEqual(got.map((f) => f.k).sort(), want.slice().sort(), `tomb (${u},${v})`);
      // Kept flames keep the order of the candidates, and no flame is an entry flame.
      assert.deepEqual(got.map((f) => f.k), want, `tomb (${u},${v}) order`);
      for (const f of got) assert.ok(f.kind === 'route' || f.kind === 'dead', `tomb (${u},${v}): flame kind ${f.kind}`);
    }
  });
}

/** BFS tree over `world.step` from `root`, kept to the boards of `allowed` ('x,y' keys): key to { x, y, cell, up, w }. */
function tree(world, allowed, root) {
  const nodes = new Map([[key(root.x, root.y, root.cell), { x: root.x, y: root.y, cell: root.cell, up: null, w: 0 }]]);
  const queue = [{ bd: world.board(root.x, root.y), cell: root.cell }];
  for (let h = 0; h < queue.length; h++) {
    const at = queue[h];
    for (let d = 0; d < 8; d++) {
      const n = world.step(at.bd, at.cell, d);
      if (!n || !allowed.has(boardKey(n.board))) continue;
      const k = key(n.board.x, n.board.y, n.cell);
      if (nodes.has(k)) continue;
      nodes.set(k, { x: n.board.x, y: n.board.y, cell: n.cell, up: key(at.bd.x, at.bd.y, at.cell), w: COST[d] });
      queue.push({ bd: n.board, cell: n.cell });
    }
  }
  return nodes;
}

/** The walk from `a` to `b` through a BFS tree: its cell keys and cumulative ms. */
function route(nodes, a, b) {
  const climb = (k) => { const out = []; for (let c = k; c !== null; c = nodes.get(c).up) out.push(c); return out; };
  const ka = key(a.x, a.y, a.cell), kb = key(b.x, b.y, b.cell);
  assert.ok(nodes.has(ka) && nodes.has(kb), `no walk from ${ka} to ${kb}`);
  const ua = climb(ka), ub = climb(kb);
  const above = new Set(ub);
  const top = ua.find((k) => above.has(k));
  const up = ua.indexOf(top);
  const keys = [...ua.slice(0, up + 1), ...ub.slice(0, ub.indexOf(top)).reverse()];
  const cum = [0];
  for (let i = 1; i < keys.length; i++) cum.push(cum[i - 1] + nodes.get(i <= up ? keys[i - 1] : keys[i]).w);
  return { keys, cum, total: cum[cum.length - 1] };
}

/** Entry j's way on in tomb (u, v): its boards from the entry to X, P, Q, the exit door's cell and the board across it. */
function wayOn(world, u, v, j) {
  const t = world.tomb(u, v);
  const path = [t.entries[j]];
  while (t.next[path[path.length - 1]] >= 0) path.push(t.next[path[path.length - 1]]);
  const boards = path.map((i) => boardAt(world, u, v, i));
  const first = boards[0], X = boards[boards.length - 1];
  const inDoor = !t.source;
  const P = {
    x: first.x, y: first.y,
    cell: inDoor ? first.doors.find((dr) => dr.dir === t.walls[j + 1].dir).cell : flameCell(world, first.x, first.y),
  };
  const exitCell = X.doors.find((dr) => dr.dir === t.exit).cell;
  const across = world.step(X, exitCell, t.exit);
  return { boards, P, Q: { x: across.board.x, y: across.board.y, cell: across.cell }, exitCell, inDoor, down: across.board };
}

/** Walk limit of stretch i of a chain of n members: 150 s, less 75 s for an in-door start and for the end. */
const limitOf = (i, n, inDoor) => GAP_LIMIT_MS - (inDoor && i === 0 ? GAP_LIMIT_MS / 2 : 0) - (i + 2 === n ? GAP_LIMIT_MS / 2 : 0);

/** The flames in `cells` of board `bd` in walking order from `inCell` toward `outCell`: by where their path leaves the main line, then by distance off it, then by cell. */
function walkingOrder(world, bd, inCell, outCell, cells) {
  const nodes = tree(world, new Set([boardKey(bd)]), { x: bd.x, y: bd.y, cell: inCell });
  const at = (cell) => ({ x: bd.x, y: bd.y, cell });
  const main = route(nodes, at(inCell), at(outCell)).keys;
  const keyed = cells.map((cell) => {
    const p = route(nodes, at(inCell), at(cell)).keys;
    let k = 0;
    while (k + 1 < p.length && k + 1 < main.length && p[k + 1] === main[k + 1]) k++;
    return { cell, k, off: p.length - 1 - k };
  });
  keyed.sort((p, q) => p.k - q.k || p.off - q.off || p.cell - q.cell);
  return keyed.map((e) => e.cell);
}

/**
 * The test's own chains of tomb (u, v) from its kept flames: each entry's
 * start at P, the flames on its way on in walking order and the end at Q,
 * where a stretch over its limit gains a flame at its midpoint cell, the exit
 * door's cell when the midpoint lies past the door, until none exceeds it.
 * Gap flames of one chain count as flames for the next.
 */
function ownChains(world, u, v, kept) {
  const t = world.tomb(u, v);
  const extra = [];
  const chains = t.entries.map((_, j) => {
    const { boards, P, Q, exitCell, inDoor, down } = wayOn(world, u, v, j);
    const allowed = new Set([...boards, down].map(boardKey));
    const chain = [{ ...P, kind: 'start' }];
    boards.forEach((bd, k) => {
      const inCell = k === 0 ? P.cell : bd.doors.find((dr) => dr.dir === dirTo(bd, boards[k - 1])).cell;
      const outCell = k + 1 < boards.length ? bd.doors.find((dr) => dr.dir === dirTo(bd, boards[k + 1])).cell : exitCell;
      const here = [...kept, ...extra].filter((f) => f.x === bd.x && f.y === bd.y);
      const cells = [...new Set(here.map((f) => f.cell))];
      for (const cell of walkingOrder(world, bd, inCell, outCell, cells)) {
        chain.push({ x: bd.x, y: bd.y, cell, kind: here.find((f) => f.cell === cell).kind === 'gap' ? 'gap' : 'route' });
      }
    });
    chain.push({ ...Q, kind: 'end' });
    const nodes = tree(world, allowed, P);
    for (let i = 0; i + 1 < chain.length;) {
      const w = route(nodes, chain[i], chain[i + 1]);
      if (w.total <= limitOf(i, chain.length, inDoor)) { i++; continue; }
      const at = nodes.get(w.keys[w.cum.findIndex((c) => 2 * c >= w.total)]);
      const past = at.x === down.x && at.y === down.y;
      const f = past ? { x: boards[boards.length - 1].x, y: boards[boards.length - 1].y, cell: exitCell, kind: 'gap' } : { x: at.x, y: at.y, cell: at.cell, kind: 'gap' };
      extra.push(f);
      chain.splice(i + 1, 0, f);
    }
    return chain;
  });
  return { chains, gaps: extra };
}

for (const d of DIFFICULTIES) {
  test(`P3 ${d}: chains run from P to Q, stretches stay in their limits, crossings take at most 150 s, and the test's own fill reproduces the gap flames`, () => {
    const world = worlds[d];
    const trails = new Map(), leads = new Map();
    let crossings = 0;
    for (const [u, v] of tombs()) {
      const fs = world.tombFlames(u, v);
      const own = ownChains(world, u, v, greedy(world, u, v));
      assert.deepEqual(
        fs.flames.filter((f) => f.kind === 'gap').map((f) => key(f.x, f.y, f.cell)).sort(),
        own.gaps.map((f) => key(f.x, f.y, f.cell)).sort(),
        `tomb (${u},${v}) gap flames`,
      );
      assert.equal(fs.chains.length, world.tomb(u, v).entries.length);
      fs.chains.forEach((chain, j) => {
        const at = `tomb (${u},${v}) entry ${j + 1}`;
        const { boards, P, Q, inDoor, down } = wayOn(world, u, v, j);
        const first = chain[0], end = chain[chain.length - 1];
        assert.deepEqual([first.kind, first.x, first.y, first.cell], ['start', P.x, P.y, P.cell], `${at} starts at P`);
        assert.deepEqual([end.kind, end.x, end.y, end.cell], ['end', Q.x, Q.y, Q.cell], `${at} ends at Q`);
        for (const f of chain.slice(1, -1)) assert.ok(f.kind === 'route' || f.kind === 'gap', `${at}: member kind ${f.kind}`);
        assert.deepEqual(chain.map((f) => key(f.x, f.y, f.cell)), own.chains[j].map((f) => key(f.x, f.y, f.cell)), `${at} chain`);
        assert.equal(fs.gaps.length, fs.chains.reduce((n, c) => n + c.length - 1, 0));
        const nodes = tree(world, new Set([...boards, down].map(boardKey)), P);
        const ms = [];
        for (let i = 0; i + 1 < chain.length; i++) {
          ms.push(route(nodes, chain[i], chain[i + 1]).total);
          assert.ok(ms[i] <= limitOf(i, chain.length, inDoor), `${at}: stretch ${i} takes ${ms[i]} ms`);
        }
        assert.deepEqual(fs.gaps.slice(fs.chains.slice(0, j).reduce((n, c) => n + c.length - 1, 0)).slice(0, ms.length), ms, `${at} gaps`);
        const qk = key(Q.x, Q.y, Q.cell);
        trails.set(qk, [...(trails.get(qk) ?? []), ms[ms.length - 1]]);
        if (inDoor) leads.set(key(P.x, P.y, P.cell), ms[0]);
      });
    }
    // A crossing is an upstream chain's trail to Q and the downstream chain's lead from it.
    for (const [k, lead] of leads) {
      for (const trail of trails.get(k) ?? []) {
        crossings++;
        assert.ok(trail + lead <= GAP_LIMIT_MS, `crossing at ${k}: ${trail} + ${lead} ms`);
      }
    }
    assert.ok(crossings > 0, 'the sample holds tomb crossings');
  });
}

test('every flame lies on its own tomb\'s boards, and a board reads its own tomb\'s flames alone', () => {
  // A limit of 4 s halves to 2 s, so many stretches split, a way on from an in-door straight to Q (limit 0) among them.
  for (const d of DIFFICULTIES) {
    for (const gapLimitMs of [150000, 4000]) {
      const world = createWorld('00000000', { difficulty: d, gapLimitMs });
      for (let v = 0; v <= 3; v++) {
        for (let u = -1; u <= 1; u++) {
          const fs = world.tombFlames(u, v);
          for (const f of fs.flames) {
            assert.deepEqual(tombOf(f.x, f.y, world.size), { u, v }, `${d} limit ${gapLimitMs}: tomb (${u},${v}) flame (${f.x},${f.y}):${f.cell}`);
          }
          for (let i = 0; i < world.size.w * world.size.h; i++) {
            const bd = boardAt(world, u, v, i);
            const want = fs.flames.filter((f) => f.x === bd.x && f.y === bd.y).map((f) => f.cell);
            assert.deepEqual(world.flamesAt(bd.x, bd.y), [...new Set(want)].sort((p, q) => p - q), `${d} limit ${gapLimitMs}: board (${bd.x},${bd.y})`);
          }
        }
      }
    }
  }
});

test('a midpoint past the exit door takes the exit door\'s cell, so a stretch to Q still splits on its own tomb', () => {
  // ULTIMATE seed 0000-000A at a 3.88 s limit has a trail of 1.943 s ending in the up door's 1 s crossing: its midpoint is
  // Q itself, one board over the tomb wall.
  const world = createWorld('0000000A', { difficulty: 'ultimate', gapLimitMs: 3880 });
  let atDoor = 0;
  for (let v = 0; v <= 3; v++) {
    for (let u = -1; u <= 1; u++) {
      const t = world.tomb(u, v);
      const X = boardAt(world, u, v, t.X);
      const door = X.doors.find((d) => d.dir === t.exit).cell;
      for (const f of world.tombFlames(u, v).flames) {
        assert.deepEqual(tombOf(f.x, f.y, world.size), { u, v }, `tomb (${u},${v}) flame (${f.x},${f.y}):${f.cell}`);
        if (f.kind === 'gap' && f.x === X.x && f.y === X.y && f.cell === door) atDoor++;
      }
    }
  }
  assert.ok(atDoor > 0, 'a gap flame stands at an exit door');
});

test('flames, dropped candidates, first-board flames and gap flames per tomb by level', () => {
  const perTomb = { easy: '1.45', medium: '3.07', hard: '5.67', ultimate: '8.64' };
  const dropped = { easy: [1, 2], medium: [0, 3], hard: [1, 9], ultimate: [1, 4] };
  const first = { easy: 35, medium: 40, hard: 38, ultimate: 39 };
  const gap = { easy: 36, medium: 13, hard: 11, ultimate: 9 };
  for (const d of DIFFICULTIES) {
    const world = worlds[d];
    let flames = 0, route = 0, dead = 0, board0 = 0, gaps = 0;
    for (const [u, v] of tombs()) {
      const keys = new Set(placed(world, u, v).map((f) => f.k));
      const fs = world.tombFlames(u, v);
      flames += fs.flames.length;
      gaps += fs.flames.filter((f) => f.kind === 'gap').length;
      for (const f of fs.flames) {
        assert.ok(['route', 'dead', 'gap'].includes(f.kind), `${d}: flame kind ${f.kind}`);
        if (f.kind === 'route' && world.tomb(u, v).routes.some((r) => boardAt(world, u, v, r[0]).x === f.x && boardAt(world, u, v, r[0]).y === f.y)) board0++;
      }
      for (const c of candidates(world, u, v)) {
        if (keys.has(key(c.bd.x, c.bd.y, c.cell))) continue;
        if (c.kind === 'route') route++;
        else dead++;
      }
    }
    assert.equal((flames / 100).toFixed(2), perTomb[d], d);
    assert.deepEqual([route, dead], dropped[d], d);
    assert.equal(board0, first[d], `${d} first-board flames`);
    assert.equal(gaps, gap[d], `${d} gap flames`);
  }
});

test('ULTIMATE tomb (2, 10) drops a dead-end candidate at board (16, 40) cell 74, exactly 20.0 s from the route flame at (15, 40) cell 8', () => {
  const world = worlds.ultimate;
  assert.equal(world.tombFlames(2, 10).flames.some((f) => f.x === 16 && f.y === 40 && f.cell === 74), false);
  assert.ok(candidates(world, 2, 10).some((c) => c.kind === 'dead' && c.bd.x === 16 && c.bd.y === 40 && c.cell === 74));
  assert.equal(world.tombFlames(2, 10).flames.some((f) => f.x === 15 && f.y === 40 && f.cell === 8), true);
  const at = reach(world, world.board(16, 40), 74).get(key(15, 40, 8));
  assert.equal(at?.ms, 20000);
});

test('ULTIMATE tomb (0, 4) drops a tributary\'s board-0 candidate at board (5, 17) cell 63, 7.0 s from the route flame at (4, 17) cell 47', () => {
  const world = worlds.ultimate;
  const t = world.tomb(0, 4);
  const board0 = t.routes.map((r) => boardAt(world, 0, 4, r[0]));
  assert.ok(board0.slice(1).some((bd) => bd.x === 5 && bd.y === 17), 'board (5, 17) starts a tributary');
  assert.ok(world.H('flame', 5, 17)[0] < FIRST_BOARD_BYTE, 'its flame byte makes it a candidate');
  assert.equal(world.tombFlames(0, 4).flames.some((f) => f.x === 5 && f.y === 17 && f.cell === 63), false);
  assert.equal(world.tombFlames(0, 4).flames.some((f) => f.x === 4 && f.y === 17 && f.cell === 47 && f.kind === 'route'), true);
  const at = reach(world, world.board(5, 17), 63).get(key(4, 17, 47));
  assert.equal(at?.ms, 7000);
});
