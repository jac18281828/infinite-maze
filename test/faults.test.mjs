// Each acceptance check passes a sound world and rejects one broken on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, acrossDoor, cellPath, doorCell, boardCoords, routeBands } from '../src/world/world.mjs';
import { DX, DY, NCELL } from '../src/world/board.mjs';
import { WALL_DIR } from '../src/world/band.mjs';
import { blockOf, WX, WY } from '../src/world/route.mjs';
import {
  checkContinuity, checkTree, checkBounds, checkGalleries, checkCarve, checkFlames, checkSolvability, checkSaves,
  checkSimpleRoute, checkWalls, checkStartChain, checkLocate, bandShape, walkRoute,
} from '../tools/acceptance.mjs';

const I0 = -2, I1 = 2;
const world = createWorld('00000000');
const key = (a, b) => `${a},${b}`;

/** A view of `world` with some boards and band flames (keyed `u,v`) replaced. */
function broken(base, { boards = new Map(), flames = new Map() } = {}) {
  return {
    ...base,
    board: (x, y) => boards.get(key(x, y)) ?? base.board(x, y),
    bandFlames: (u, v) => flames.get(key(u, v)) ?? base.bandFlames(u, v),
    flamesAt: (x, y) => {
      let cells = base.flamesAt(x, y);
      for (const [fk, fs] of flames) {
        const orig = base.bandFlames(...fk.split(',').map(Number));
        for (const f of orig.flames) {
          if (f.x === x && f.y === y && !fs.flames.includes(f)) cells = cells.filter((c) => c !== f.cell);
        }
      }
      return cells;
    },
    _set: (x, y, bd) => boards.set(key(x, y), bd),
  };
}

function copyBoard(bd) {
  return { ...bd, doors: bd.doors.map((d) => ({ ...d })), links: bd.links.slice(), doorMask: bd.doorMask.slice() };
}

function addDoor(bd, dir, cell) {
  bd.doors.push({ dir, cell });
  bd.doorMask[cell] |= 1 << dir;
}

function dropDoor(bd, dir) {
  const dr = bd.doors.find((d) => d.dir === dir);
  bd.doors = bd.doors.filter((d) => d !== dr);
  bd.doorMask[dr.cell] &= ~(1 << dir);
}

function setLink(bd, c, d) {
  const t = ((c / 12) | 0) * 12 + (c % 12) + DY[d] * 12 + DX[d];
  bd.links[c] |= 1 << d;
  bd.links[t] |= 1 << (d ^ 2);
}

function clearLink(bd, c, d) {
  const t = ((c / 12) | 0) * 12 + (c % 12) + DY[d] * 12 + DX[d];
  bd.links[c] &= ~(1 << d);
  bd.links[t] &= ~(1 << (d ^ 2));
}

/** Route band i of the sound world, as { u, v }. */
const routeBand = (i) => routeBands(world, i, i)[0];

/** Tree boards of route bands I0..I1. */
function treeBoards() {
  const out = [];
  for (const rb of walkRoute(world, I0, I1).bands) for (const bd of bandShape(world, rb).boards) if (bd.links) out.push(bd);
  return out;
}

/**
 * Replaces each gallery of `bd` with orthogonal links through a free corner
 * of its block that rejoin the two halves, so the board stays a tree. A
 * corner the carved tree holds takes one link to the far end; when both
 * corners are pruned, one takes two links and becomes carved.
 */
function withoutGalleries(bd) {
  const flat = copyBoard(bd);
  for (let c = 0; c < 84; c++) {
    for (const d of [4, 5]) {
      if (!(flat.links[c] & (1 << d))) continue;
      clearLink(flat, c, d);
      const top = c + DX[d] + 12, side = d === 4 ? 0 : 2;
      // Free corners as [cell, direction from c, direction to the top].
      const corners = [[c + DX[d], side, 1], [c + 12, 1, side]];
      const held = corners.find(([f]) => flat.links[f]);
      if (!held) {
        setLink(flat, c, corners[0][1]);
        setLink(flat, corners[0][0], corners[0][2]);
      } else if (reachable(flat.links, c).includes(held[0])) setLink(flat, held[0], held[2]);
      else setLink(flat, c, held[1]);
      assert.ok(reachable(flat.links, c).includes(top));
    }
  }
  return flat;
}

function reachable(links, from) {
  const seen = [from];
  for (let h = 0; h < seen.length; h++) {
    for (let d = 0; d < 8; d++) {
      if (!(links[seen[h]] & (1 << d))) continue;
      const t = seen[h] + DY[d] * 12 + DX[d];
      if (!seen.includes(t)) seen.push(t);
    }
  }
  return seen;
}

test('every check passes the sound world', () => {
  assert.deepEqual(checkSimpleRoute(world, -60, 60).errors, []);
  assert.deepEqual(checkWalls(world, I0, I1).errors, []);
  assert.deepEqual(checkContinuity(world, I0, I1).errors, []);
  assert.deepEqual(checkTree(world, I0, I1).errors, []);
  assert.deepEqual(checkBounds(world, I0, I1).errors, []);
  assert.deepEqual(checkGalleries(world, I0, I1).errors, []);
  assert.deepEqual(checkCarve(world, I0, I1).errors, []);
  assert.deepEqual(checkFlames(world, I0, I1).errors, []);
  assert.deepEqual(checkSolvability(world, I0, I1).errors, []);
  assert.deepEqual(checkLocate(world, I0, I1).errors, []);
  assert.deepEqual(checkStartChain(world).errors, []);
});

test('continuity rejects a door moved on one side of its wall', () => {
  const w = broken(world);
  const { u, v } = routeBand(0);
  const bd = bandShape(world, walkRoute(world, 0, 0).at(0)).boards.find((b) => b.links && b.doors.some((d) => d.dir === 0));
  assert.ok(bd && bd.u === u && bd.v === v);
  const moved = copyBoard(bd);
  const door = moved.doors.find((d) => d.dir === 0);
  const row = (door.cell / 12) | 0;
  door.cell = (row === 5 ? 1 : row + 1) * 12 + 11;
  w._set(bd.x, bd.y, moved);
  const errors = checkContinuity(w, I0, I1).errors;
  assert.ok(errors.some((e) => e.includes(`board (${bd.x},${bd.y})`) && e.includes('no partner')), errors.join('\n'));
});

test('tree rejects an extra link that closes a loop', () => {
  const w = broken(world);
  const bd = world.entryBoard(0, 0);
  const looped = copyBoard(bd);
  // Two carved east neighbours that no link joins; the tree already joins them.
  const c = [...Array(84).keys()].find((i) => i % 12 < 11 && looped.links[i] && looped.links[i + 1] && !(looped.links[i] & 1));
  setLink(looped, c, 0);
  w._set(bd.x, bd.y, looped);
  const errors = checkTree(w, I0, I1).errors;
  assert.ok(errors.some((e) => e.startsWith('band (0,0):') && e.includes('edges for')), errors.join('\n'));
});

test('tree rejects a second door between consecutive route bands', () => {
  const w = broken(world);
  const a = routeBand(1), b = routeBand(2);
  const wall = [0, 1, 2, 3].find((k) => WX[k] === b.u - a.u && WY[k] === b.v - a.v);
  const d = WALL_DIR[wall];
  let added = null;
  for (let i = 0; i < 24 && !added; i++) {
    const { x, y } = boardCoords(a.u, a.v, i);
    const nx = x + DX[d], ny = y + DY[d];
    if (Math.floor(nx / 6) !== b.u || Math.floor(ny / 4) !== b.v) continue;
    const inner = world.board(x, y), outer = world.board(nx, ny);
    if (!inner.links || !outer.links || inner.doors.some((dr) => dr.dir === d)) continue;
    const cell = doorCell(world.H, x, y, d);
    const s = copyBoard(inner), t = copyBoard(outer);
    addDoor(s, d, cell);
    addDoor(t, d ^ 2, acrossDoor(cell, d));
    w._set(x, y, s);
    w._set(nx, ny, t);
    added = { x, y };
  }
  assert.ok(added, 'no board pair along the wall holds two tree boards without a door');
  const errors = checkTree(w, I0, I1).errors;
  assert.ok(errors.some((e) => e.startsWith(`band (${a.u},${a.v}) wall ${'LRDU'[wall]}: 2 doors inside and 2 outside`)), errors.join('\n'));
});

/** First cell on wall d of `bd`, door rows or columns only, carved on `bd` and across it on `far`. */
function sharedDoorCell(bd, far, d) {
  const cells = d === 0 || d === 2 ? [1, 2, 3, 4, 5].map((r) => r * 12 + (d === 0 ? 11 : 0)) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => (d === 1 ? 72 : 0) + c);
  return cells.find((c) => bd.links[c] && far.links[acrossDoor(c, d)]);
}

test('bounds rejects a dead-end branch 3 boards deep', () => {
  // Seed 0000-0001: route bands -2 and -1 hold depth-2 boards beside rock in their own band.
  const sound = createWorld('00000001');
  const w = broken(sound);
  let made = null;
  for (const rb of walkRoute(sound, I0, I1).bands) {
    const shape = bandShape(sound, rb);
    const entry = sound.entryBoard(rb.u, rb.v);
    shape.boards.forEach((bd, i) => {
      if (made || shape.depth[i] !== 2) return;
      for (let d = 0; d < 4 && !made; d++) {
        const nx = bd.x + DX[d], ny = bd.y + DY[d];
        if (Math.floor(nx / 6) !== rb.u || Math.floor(ny / 4) !== rb.v) continue;
        const rock = sound.board(nx, ny);
        if (rock.links) continue;
        const cell = sharedDoorCell(bd, entry, d);
        if (cell === undefined) continue;
        const deep = copyBoard(bd);
        addDoor(deep, d, cell);
        const leaf = {
          ...copyBoard(entry), x: nx, y: ny, p: rock.p, kind: 'dead', fallback: true,
          doors: [{ dir: d ^ 2, cell: acrossDoor(cell, d) }],
        };
        w._set(bd.x, bd.y, deep);
        w._set(nx, ny, leaf);
        made = { x: nx, y: ny };
      }
    });
    if (made) break;
  }
  assert.ok(made, 'no depth-2 board borders rock');
  assert.deepEqual(checkBounds(sound, I0, I1).errors, []);
  const errors = checkBounds(w, I0, I1).errors;
  assert.ok(errors.some((e) => e.includes(`(${made.x},${made.y})`) && e.includes('3 boards deep')), errors.join('\n'));
  // The deeper board still forms a valid tree, so only bounds can catch it.
  assert.deepEqual(checkTree(w, I0, I1).errors, []);
});

/** A view of `world` with the first `n` tree boards flagged as fallbacks. */
function withFallbacks(n) {
  const w = broken(world);
  for (const bd of treeBoards().slice(0, n)) w._set(bd.x, bd.y, { ...copyBoard(bd), fallback: true });
  return w;
}

test('bounds rejects a run over the fallback ceiling and passes the sound world', () => {
  const boards = treeBoards().length;
  const w = withFallbacks(Math.ceil(boards / 20));
  assert.deepEqual(checkTree(w, I0, I1).errors, []);
  // Lowering the 2,000-board threshold below this world's size enforces the ceiling.
  const errors = checkBounds(w, I0, I1, boards).errors;
  assert.ok(errors.some((e) => e.includes('ceiling') && /\(\d+\.\d%\)/.test(e)), errors.join('\n'));
  assert.deepEqual(checkBounds(world, I0, I1, boards).errors, []);
});

test('bounds reports a fallback rate over the ceiling on a run under 2,000 boards', () => {
  const w = withFallbacks(Math.ceil(treeBoards().length / 20));
  const r = checkBounds(w, I0, I1);
  assert.ok(r.boards < 2000);
  assert.ok(100 * r.fallbacks > 2 * r.boards);
  assert.deepEqual(r.errors, []);
});

test('galleries rejects a corridor inside a gallery block of a valid tree', () => {
  // The corridor from a north-east gallery's foot east closes a cycle through
  // the tree path back; dropping a path link other than the gallery leaves a
  // tree. The first board whose tangle still meets the targets serves.
  let found = null;
  for (const bd of treeBoards()) {
    // The carve may prune the side cell c + 1, which cellPath cannot reach.
    const c = bd.links.findIndex((m, i) => m & 16 && bd.links[i + 1]);
    if (c < 0) continue;
    const g = new Set([c, c + 13]);
    const tangled = copyBoard(bd);
    setLink(tangled, c, 0);
    const { cells, dirs } = cellPath(bd.links, c, c + 1);
    const k = dirs.findIndex((_, j) => !(g.has(cells[j]) && g.has(cells[j + 1])));
    clearLink(tangled, cells[k], dirs[k]);
    const w = broken(world);
    w._set(bd.x, bd.y, tangled);
    if (checkBounds(w, I0, I1).errors.length === 0) { found = { bd, c, w }; break; }
  }
  assert.ok(found, 'no board with a north-east gallery survives the tangle');
  const { bd, c, w } = found;
  const errors = checkGalleries(w, I0, I1).errors;
  assert.ok(errors.some((e) => e.startsWith(`board (${bd.x},${bd.y}): gallery ${c}`) && e.includes('shares its block')), errors.join('\n'));
  // The board stays a valid tree, so only the galleries check catches it.
  assert.deepEqual(checkTree(w, I0, I1).errors, []);
  assert.deepEqual(checkBounds(w, I0, I1).errors, []);
});

test('galleries rejects a world averaging under 4 galleries per board', () => {
  const sound = checkGalleries(world, I0, I1);
  assert.ok(sound.mean >= 4, `sound mean ${sound.mean}`);
  const w = broken(world);
  let galleries = sound.galleries;
  for (const bd of treeBoards()) {
    if (galleries < 4 * sound.boards) break;
    const flat = withoutGalleries(bd);
    for (let c = 0; c < 84; c++) galleries -= ((bd.links[c] >> 4) & 1) + ((bd.links[c] >> 5) & 1);
    w._set(bd.x, bd.y, flat);
  }
  const r = checkGalleries(w, I0, I1);
  assert.ok(r.mean < 4 && r.mean > 3.5, `mean ${r.mean}`);
  assert.equal(r.conflicts, 0);
  assert.ok(r.errors.some((e) => e.includes('galleries per board average')), r.errors.join('\n'));
  assert.deepEqual(checkTree(w, I0, I1).errors, []);
});

/**
 * `bd` relinked as a spanning tree whose galleries are exactly `diagonals`,
 * [cell, dir] pairs: corridors and ladders join every other cell pair, but
 * none joins two cells of one gallery's block.
 */
function treeWithGalleries(bd, diagonals) {
  const out = copyBoard(bd);
  out.links.fill(0);
  const root = [...Array(84).keys()];
  const find = (c) => (root[c] === c ? c : (root[c] = find(root[c])));
  const blocks = diagonals.map(([c, d]) => {
    const a = d === 4 ? c : c - 1;
    return [a, a + 1, a + 12, a + 13];
  });
  for (const [c, d] of diagonals) {
    setLink(out, c, d);
    root[find(c)] = find(c + DX[d] + 12);
  }
  for (let c = 0; c < 84; c++) {
    for (const d of [0, 1]) {
      if ((d === 0 && c % 12 === 11) || (d === 1 && c >= 72)) continue;
      const t = c + (d === 0 ? 1 : 12);
      if (blocks.some((b) => b.includes(c) && b.includes(t)) || find(c) === find(t)) continue;
      setLink(out, c, d);
      root[find(c)] = find(t);
    }
  }
  assert.equal(reachable(out.links, 0).length, 84, 'the relinked board spans every cell');
  return out;
}

test('galleries rejects two gallery blocks that share a cell in a valid tree', () => {
  const w = broken(world);
  const bd = treeBoards()[0];
  // North-east galleries from cells 0 and 1: their blocks share cells 1 and 13.
  w._set(bd.x, bd.y, treeWithGalleries(bd, [[0, 4], [1, 4]]));
  const errors = checkGalleries(w, I0, I1).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): gallery 1 dir 4 overlaps another block`), errors.join('\n'));
  assert.ok(!errors.some((e) => e.includes('shares its block')), errors.join('\n'));
  // The board stays a valid tree, so only the galleries check catches it.
  assert.deepEqual(checkTree(w, I0, I1).errors, []);
});

test('galleries rejects a world averaging over 10 galleries per board', () => {
  const sound = checkGalleries(world, I0, I1);
  assert.ok(sound.mean <= 10, `sound mean ${sound.mean}`);
  // Fifteen disjoint blocks: rows 0-1, 2-3 and 4-5, columns 0-9 in pairs.
  const dense = [];
  for (let r = 0; r < 6; r += 2) for (let k = 0; k < 10; k += 2) dense.push([r * 12 + k, 4]);
  const w = broken(world);
  let galleries = sound.galleries;
  for (const bd of treeBoards()) {
    if (galleries > 10 * sound.boards) break;
    for (let c = 0; c < 84; c++) galleries -= ((bd.links[c] >> 4) & 1) + ((bd.links[c] >> 5) & 1);
    galleries += dense.length;
    w._set(bd.x, bd.y, treeWithGalleries(bd, dense));
  }
  const r = checkGalleries(w, I0, I1);
  assert.ok(r.mean > 10 && r.mean < 10.5, `mean ${r.mean}`);
  assert.equal(r.conflicts, 0);
  assert.ok(r.errors.some((e) => e.includes('galleries per board average')), r.errors.join('\n'));
  assert.deepEqual(checkTree(w, I0, I1).errors, []);
});

/** Cells of `bd` that hold exactly one link, none of them a door cell. */
function leaves(bd) {
  const doorCells = bd.doors.map((d) => d.cell);
  return [...Array(NCELL).keys()].filter((c) => bd.links[c] && !(bd.links[c] & (bd.links[c] - 1)) && !doorCells.includes(c));
}

/** `bd` copied with the single link of leaf c cleared, so c is pruned. */
function pruned(bd, c) {
  const out = copyBoard(bd);
  clearLink(out, c, Math.log2(out.links[c]));
  return out;
}

test('carve rejects the uncarved world', () => {
  const full = createWorld('00000000', { carveCells: NCELL });
  const r = checkCarve(full, I0, I1);
  assert.equal(r.mean, NCELL);
  assert.ok(r.errors.some((e) => e.includes('average 84.00')), r.errors.join('\n'));
  assert.deepEqual(checkTree(full, I0, I1).errors, []);
});

test('carve rejects a pruned flame cell', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => leaves(b).some((c) => world.flamesAt(b.x, b.y).includes(c)));
  const c = leaves(bd).find((u) => world.flamesAt(bd.x, bd.y).includes(u));
  w._set(bd.x, bd.y, pruned(bd, c));
  const errors = checkCarve(w, I0, I1).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): flame cell ${c} is pruned`), errors.join('\n'));
  // The board stays a tree, so only the carve check catches it.
  assert.deepEqual(checkTree(w, I0, I1).errors, []);
});

test('carve rejects a door cell stripped of its links', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => b.doors.some((d) => b.links[d.cell] && !(b.links[d.cell] & (b.links[d.cell] - 1))));
  const door = bd.doors.find((d) => bd.links[d.cell] && !(bd.links[d.cell] & (bd.links[d.cell] - 1)));
  w._set(bd.x, bd.y, pruned(bd, door.cell));
  const errors = checkCarve(w, I0, I1).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): door cell ${door.cell} is pruned`), errors.join('\n'));
});

test('carve rejects a board carved to 49 cells', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => b.links.filter(Boolean).length === 50 && leaves(b).length);
  const c = leaves(bd)[0];
  assert.deepEqual(checkCarve(world, I0, I1).errors, []);
  w._set(bd.x, bd.y, pruned(bd, c));
  const errors = checkCarve(w, I0, I1).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): 49 carved cells, under 50`), errors.join('\n'));
});

test('flames rejects a removed flame that opens a gap over 150 s', () => {
  // In seed 0000-002Z, route band -2, dropping chain flame 1 leaves a 153.7 s walk.
  const base = createWorld('0000002Z');
  const i = -2;
  const [{ u, v }] = routeBands(base, i, i);
  assert.deepEqual(checkFlames(base, i, i).errors, []);
  const fs = base.bandFlames(u, v);
  const gone = fs.chain[1];
  assert.equal(gone.kind, 'route');
  const w = broken(base, {
    flames: new Map([[key(u, v), { ...fs, chain: fs.chain.filter((f) => f !== gone), flames: fs.flames.filter((f) => f !== gone) }]]),
  });
  assert.ok(!w.flamesAt(gone.x, gone.y).includes(gone.cell));
  const errors = checkFlames(w, i, i).errors;
  assert.ok(errors.some((e) => e.includes('flame gap 153.7 s exceeds 150 s')), errors.join('\n'));
});

test('flames rejects a band entry without a flame', () => {
  const { u, v } = routeBand(1);
  const entry = world.entryBoard(u, v);
  const fs = world.bandFlames(u, v);
  const entryFlame = fs.chain[0];
  const w = broken(world, {
    flames: new Map([[key(u, v), { ...fs, flames: fs.flames.filter((f) => f !== entryFlame) }]]),
  });
  assert.equal(w.flamesAt(entry.x, entry.y).length, 0);
  const errors = checkFlames(w, 1, 1).errors;
  assert.ok(errors.some((e) => e.includes('entry holds no flame')), errors.join('\n'));
});

test('solvability rejects a world cut at a band seam', () => {
  const w = broken(world);
  const { u, v } = routeBand(1);
  const bd = world.entryBoard(u, v);
  const cut = copyBoard(bd);
  dropDoor(cut, WALL_DIR[world.tree(u, v).entryWall]);
  w._set(bd.x, bd.y, cut);
  const errors = checkSolvability(w, I0, I1).errors;
  assert.ok(errors.some((e) => e.includes('unreachable')), errors.join('\n'));
});

test('saves rejects a resumed board that differs from the board in sequence', () => {
  const bd = world.entryBoard(0, 0);
  const at = [bd.x, bd.y];
  assert.deepEqual(checkSaves(world, [at]).errors, []);
  const changed = copyBoard(bd);
  setLink(changed, [...Array(84).keys()].find((i) => i % 12 < 11 && !(changed.links[i] & 1)), 0);
  const w = broken(world);
  w._set(bd.x, bd.y, changed);
  const errors = checkSaves(w, [at]).errors;
  assert.ok(errors.includes(`board at p=${bd.p} differs when resumed`), errors.join('\n'));
});

// ROUTE section 9: each broken world names the check that must reject it.

test('simple route rejects a block path that visits a child twice', () => {
  const w = createWorld('00000000', { revisitLevel: 2 });
  const errors = checkSimpleRoute(w, -30, 30).errors;
  assert.ok(errors.some((e) => e.includes('cannot leave') || e.includes('visited again')), errors.join('\n'));
});

test('continuity rejects a door offset that differs on the two sides of one block wall', () => {
  // The first level-2 crossing past the level-2 start block, between two siblings off the start chain.
  const bands = routeBands(world, 0, 60);
  const b2 = (b) => [blockOf(2, b.u), blockOf(2, b.v)];
  const at = bands.findIndex((b, i) => {
    const n = bands[i + 1];
    if (!n) return false;
    const [i0, j0] = b2(b), [i1, j1] = b2(n);
    const siblings = blockOf(3, b.u) === blockOf(3, n.u) && blockOf(3, b.v) === blockOf(3, n.v);
    return (i0 !== i1 || j0 !== j1) && siblings && (i0 || j0) && (i1 || j1);
  });
  assert.ok(at >= 0, 'no level-2 crossing between non-start siblings');
  const b = bands[at], n = bands[at + 1];
  const wall = [0, 1, 2, 3].find((k) => WX[k] === n.u - b.u && WY[k] === n.v - b.v);
  const skewWall = { k: 2, i: blockOf(2, b.u), j: blockOf(2, b.v), w: wall };
  const w = createWorld('00000000', { skewWall });
  const errors = checkContinuity(w, -60, 60).errors;
  assert.ok(errors.some((e) => e.includes('no partner')), errors.join('\n'));
  assert.deepEqual(checkContinuity(world, -2, Math.min(at, 2)).errors, []);
});

test('start chain rejects a start block placed off centre', () => {
  const errors = checkStartChain(createWorld('00000000', { offCentre: true })).errors;
  assert.ok(errors.some((e) => e.includes('centre child') || e.includes('no wall pair')), errors.join('\n'));
});

test('walls rejects a band whose two boundary doors share a wall', () => {
  // Band (0, 0) keeps its entry and moves its exit onto its entry wall, held on both sides.
  const t = world.tree(0, 0);
  const E = t.entryWall, d = WALL_DIR[E];
  const copies = new Map();
  const copy = (bd) => { if (!copies.has(key(bd.x, bd.y))) copies.set(key(bd.x, bd.y), copyBoard(bd)); return copies.get(key(bd.x, bd.y)); };
  const exitAt = boardCoords(0, 0, t.exit);
  dropDoor(copy(world.board(exitAt.x, exitAt.y)), WALL_DIR[t.exitWall]);
  let moved = null;
  for (let i = 0; i < 24 && !moved; i++) {
    const { x, y } = boardCoords(0, 0, i);
    const nx = x + DX[d], ny = y + DY[d];
    if (i === t.entry || (Math.floor(nx / 6) === 0 && Math.floor(ny / 4) === 0)) continue;
    const inner = world.board(x, y), outer = world.board(nx, ny);
    if (!inner.links || !outer.links) continue;
    const cell = doorCell(world.H, x, y, d);
    addDoor(copy(inner), d, cell);
    addDoor(copy(outer), d ^ 2, acrossDoor(cell, d));
    moved = { x, y };
  }
  assert.ok(moved, 'no second board pair on the entry wall holds two tree boards');
  const w = broken(world);
  for (const bd of copies.values()) w._set(bd.x, bd.y, bd);
  const errors = checkWalls(w, I0, I1).errors;
  assert.ok(errors.includes(`band (0,0): 2 boundary doors share wall ${'LRDU'[E]}`), errors.join('\n'));
});

test('locate rejects a world whose location gives one band a wrong exit', () => {
  const { u, v } = routeBand(3);
  const w = createWorld('00000000', { wrongExit: { u, v } });
  const errors = checkLocate(w, -5, 5).errors;
  assert.ok(errors.some((e) => e.startsWith(`band (${u},${v}): locates its exit`)), errors.join('\n'));
});
