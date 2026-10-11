// Each acceptance check passes a sound world and rejects one broken on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, acrossDoor, posOf, cellPath, boardCoords } from '../src/world/world.mjs';
import { DX, DY, NCELL } from '../src/world/board.mjs';
import {
  checkContinuity, checkTree, checkFlow, checkAcyclic, checkBounds, checkGalleries, checkCarve, checkFlames,
  checkSolvability, checkSaves, checkWayUp, tombShape, tombWindow, measureTargets, thresholds, LEVELS, WAY_UP_CAP,
} from '../tools/acceptance.mjs';

const WIN = tombWindow(-1, 1, -2, 2);
const world = createWorld('00000000');

/** A view of `world` with some boards, tombs and flame sets replaced. */
function broken(base, { boards = new Map(), flames = new Map(), tombs = new Map() } = {}) {
  const key = (x, y) => `${x},${y}`;
  return {
    ...base,
    board: (x, y) => boards.get(key(x, y)) ?? base.board(x, y),
    tomb: (u, v) => tombs.get(key(u, v)) ?? base.tomb(u, v),
    tombFlames: (u, v) => flames.get(key(u, v)) ?? base.tombFlames(u, v),
    flamesAt: (x, y) => {
      let cells = base.flamesAt(x, y);
      for (const [k, fs] of flames) {
        const [u, v] = k.split(',').map(Number);
        for (const f of base.tombFlames(u, v).flames) {
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

/** Tree boards of the window's tombs. */
function treeBoards() {
  const out = [];
  for (let v = WIN.v0; v <= WIN.v1; v++) {
    for (let u = WIN.u0; u <= WIN.u1; u++) for (const bd of tombShape(world, u, v).boards) if (bd.links) out.push(bd);
  }
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
  assert.deepEqual(checkContinuity(world, WIN).errors, []);
  assert.deepEqual(checkTree(world, WIN).errors, []);
  assert.deepEqual(checkFlow(world, WIN).errors, []);
  assert.deepEqual(checkAcyclic(world, WIN).errors, []);
  assert.deepEqual(checkBounds(world, WIN).errors, []);
  assert.deepEqual(checkGalleries(world, WIN).errors, []);
  assert.deepEqual(checkCarve(world, WIN).errors, []);
  assert.deepEqual(checkFlames(world, WIN).errors, []);
  assert.deepEqual(checkSolvability(world, WIN).errors, []);
  assert.deepEqual(checkWayUp(world, WIN).errors, []);
});

test('continuity rejects a door moved on one side of its wall', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => b.doors.some((d) => d.dir === 0));
  const moved = copyBoard(bd);
  const door = moved.doors.find((d) => d.dir === 0);
  const row = (door.cell / 12) | 0;
  door.cell = (row === 5 ? 1 : row + 1) * 12 + 11;
  w._set(bd.x, bd.y, moved);
  const errors = checkContinuity(w, WIN).errors;
  assert.ok(errors.some((e) => e.includes(`board (${bd.x},${bd.y})`) && e.includes('no partner')), errors.join('\n'));
});

test('tree rejects an extra link that closes a loop', () => {
  const w = broken(world);
  const bd = world.startPoint().board;
  const looped = copyBoard(bd);
  // Two carved east neighbours that no link joins; the tree already joins them.
  const c = [...Array(84).keys()].find((i) => i % 12 < 11 && looped.links[i] && looped.links[i + 1] && !(looped.links[i] & 1));
  setLink(looped, c, 0);
  w._set(bd.x, bd.y, looped);
  const errors = checkTree(w, WIN).errors;
  assert.ok(errors.some((e) => e.startsWith('tomb (0,0):') && e.includes('edges for')), errors.join('\n'));
});

test('tree rejects a tributary dropped, leaving an in-door unjoined', () => {
  const cut = createWorld('00000000', { faults: { dropTributary: true } });
  let t = null;
  for (let v = 0; v <= 40 && !t; v++) for (let u = -3; u <= 3 && !t; u++) if (world.tomb(u, v).routes.length >= 2) t = world.tomb(u, v);
  assert.ok(t, 'no tomb with a tributary');
  const win = tombWindow(t.u, t.u, t.v, t.v);
  assert.deepEqual(checkTree(world, win).errors, []);
  const errors = checkTree(cut, win).errors;
  assert.ok(errors.some((e) => e.startsWith(`tomb (${t.u},${t.v}):`) && e.includes('components')), errors.join('\n'));
});

test('flow rejects a tomb that exits down', () => {
  const t = world.tomb(0, 0);
  const w = broken(world, { tombs: new Map([['0,0', { ...t, exit: 3 }]]) });
  const errors = checkFlow(w, WIN).errors;
  assert.ok(errors.includes('tomb (0,0): exits down'), errors.join('\n'));
});

/** The first pair (u, v), (u + 1, v) of the loose world that exits into each other, fed from below when `fed`. */
function facingPair(loose, fed = false) {
  for (let v = -5; v <= 5; v++) {
    for (let u = -5; u <= 5; u++) {
      if (loose.exit(u, v) !== 0 || loose.exit(u + 1, v) !== 2) continue;
      if (!fed || loose.exit(u, v - 1) === 1 || loose.exit(u + 1, v - 1) === 1) return [u, v];
    }
  }
  return null;
}

test('flow alone rejects two side neighbours that exit into each other, wall direction ignored', () => {
  const loose = createWorld('00000000', { faults: { ignoreWalls: true } });
  const pair = facingPair(loose);
  assert.ok(pair, 'no pair exits into each other');
  const [u, v] = pair;
  const win = tombWindow(u - 1, u + 2, v - 1, v + 1);
  assert.deepEqual(checkFlow(world, win).errors, []);
  const flow = checkFlow(loose, win).errors;
  assert.ok(flow.includes(`tombs (${u},${v}) and (${u + 1},${v}) exit into each other`), flow.join('\n'));
  // The pair shares one door, so no other check sees a fault.
  assert.deepEqual(checkContinuity(loose, win).errors, []);
  assert.deepEqual(checkTree(loose, win).errors, []);
  assert.deepEqual(checkAcyclic(loose, win).errors, []);
});

test('way up rejects a closed basin: a facing pair fed from below', () => {
  const loose = createWorld('00000000', { faults: { ignoreWalls: true } });
  const pair = facingPair(loose, true);
  assert.ok(pair, 'no facing pair is fed from below');
  const [u, v] = pair;
  const win = tombWindow(u - 1, u + 2, v - 1, v);
  assert.deepEqual(checkWayUp(world, win).errors, []);
  const errors = checkWayUp(loose, win).errors;
  const stuck = (a, b) => `tomb (${a},${b}): its way on stays at or below row ${v} for ${WAY_UP_CAP} steps`;
  assert.ok(errors.includes(stuck(u, v)) && errors.includes(stuck(u + 1, v)), errors.join('\n'));
  const feed = [u, u + 1].find((a) => loose.exit(a, v - 1) === 1);
  assert.ok(errors.includes(stuck(feed, v - 1)), errors.join('\n'));
});

/** Copies of two tree boards that face each other across wall d of tomb (u, v), each holding a new door there. */
function addWallDoor(u, v, d) {
  const { w: W, h: H } = world.size;
  for (let k = 0; k < (d % 2 === 0 ? H : W); k++) {
    const x = d === 0 ? W * u + W - 1 : W * u + k, y = d === 1 ? H * v + H - 1 : H * v + k;
    const near = world.board(x, y), far = world.board(x + DX[d], y + DY[d]);
    if (!near.links || !far.links || near.doors.some((dr) => dr.dir === d)) continue;
    const cell = d === 0 ? 3 * 12 + 11 : 72 + 5;
    const a = copyBoard(near), b = copyBoard(far);
    a.doors.push({ dir: d, cell });
    b.doors.push({ dir: d ^ 2, cell: acrossDoor(cell, d) });
    return [a, b];
  }
  return null;
}

test('flow rejects a door on a tomb wall that neither tomb exits through', () => {
  let made = null;
  for (let v = WIN.v0; v <= WIN.v1 && !made; v++) {
    for (let u = WIN.u0; u < WIN.u1 && !made; u++) {
      if (world.tomb(u, v).exit === 0 || world.tomb(u + 1, v).exit === 2) continue;
      const pair = addWallDoor(u, v, 0);
      if (pair) made = { u, v, pair };
    }
  }
  assert.ok(made, 'no side wall without an exit borders two tree boards');
  const w = broken(world);
  for (const bd of made.pair) w._set(bd.x, bd.y, bd);
  assert.deepEqual(checkContinuity(w, WIN).errors, []);
  const errors = checkFlow(w, WIN).errors;
  assert.ok(errors.includes(`tomb (${made.u},${made.v}): a door on its right wall faces a tomb that does not exit into it`), errors.join('\n'));
});

test('flow and acyclic reject a second door on an exit wall', () => {
  let made = null;
  for (let v = WIN.v0; v < WIN.v1 && !made; v++) {
    for (let u = WIN.u0; u <= WIN.u1 && !made; u++) {
      if (world.tomb(u, v).exit !== 1) continue;
      const pair = addWallDoor(u, v, 1);
      if (pair) made = { u, v, pair };
    }
  }
  assert.ok(made, 'no ceiling borders two more tree boards');
  const w = broken(world);
  for (const bd of made.pair) w._set(bd.x, bd.y, bd);
  const errors = checkFlow(w, WIN).errors;
  assert.ok(errors.includes(`tomb (${made.u},${made.v}): 2 doors on its exit wall`), errors.join('\n'));
  const acyclic = checkAcyclic(w, WIN).errors;
  assert.ok(acyclic.some((e) => e.startsWith(`tombs (${made.u},${made.v}) and (${made.u},${made.v + 1})`)), acyclic.join('\n'));
});

test('bounds rejects a dead-end branch 3 boards deep', () => {
  const w = broken(world);
  let made = null;
  for (let v = WIN.v0; v <= WIN.v1 && !made; v++) {
    for (let u = WIN.u0; u <= WIN.u1 && !made; u++) {
      const shape = tombShape(world, u, v);
      shape.boards.forEach((bd, i) => {
        if (made || shape.depth[i] !== 2) return;
        for (let d = 0; d < 4 && !made; d++) {
          const nx = bd.x + DX[d], ny = bd.y + DY[d];
          if (Math.floor(nx / world.size.w) !== u || Math.floor(ny / world.size.h) !== v) continue;
          const rock = world.board(nx, ny);
          if (rock.links) continue;
          const cell = d === 0 ? 3 * 12 + 11 : d === 2 ? 3 * 12 : d === 1 ? 72 + 5 : 5;
          const deep = copyBoard(bd);
          deep.doors.push({ dir: d, cell });
          const leaf = {
            ...copyBoard(world.startPoint().board),
            x: nx, y: ny, p: posOf(nx, ny), u, v, kind: 'dead', fallback: true,
            doors: [{ dir: d ^ 2, cell: acrossDoor(cell, d) }],
          };
          w._set(bd.x, bd.y, deep);
          w._set(nx, ny, leaf);
          made = { x: nx, y: ny };
        }
      });
    }
  }
  assert.ok(made, 'no depth-2 board borders rock');
  const errors = checkBounds(w, WIN).errors;
  assert.ok(errors.some((e) => e.includes(`(${made.x},${made.y})`) && e.includes('3 boards deep')), errors.join('\n'));
  // The deeper board still forms a valid tree, so only bounds can catch it.
  assert.deepEqual(checkTree(w, WIN).errors, []);
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
  assert.deepEqual(checkTree(w, WIN).errors, []);
  // Lowering the 2,000-board threshold below this world's size enforces the ceiling.
  const errors = checkBounds(w, WIN, boards).errors;
  assert.ok(errors.some((e) => e.includes('ceiling') && /\(\d+\.\d%\)/.test(e)), errors.join('\n'));
  assert.deepEqual(checkBounds(world, WIN, boards).errors, []);
});

test('bounds reports a fallback rate over the ceiling on a run under 2,000 boards', () => {
  const w = withFallbacks(Math.ceil(treeBoards().length / 20));
  const r = checkBounds(w, WIN);
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
    if (checkBounds(w, WIN).errors.length === 0) { found = { bd, c, w }; break; }
  }
  assert.ok(found, 'no board with a north-east gallery survives the tangle');
  const { bd, c, w } = found;
  const errors = checkGalleries(w, WIN).errors;
  assert.ok(errors.some((e) => e.startsWith(`board (${bd.x},${bd.y}): gallery ${c}`) && e.includes('shares its block')), errors.join('\n'));
  // The board stays a valid tree, so only the galleries check catches it.
  assert.deepEqual(checkTree(w, WIN).errors, []);
  assert.deepEqual(checkBounds(w, WIN).errors, []);
});

test('galleries rejects a world averaging under 4 galleries per board', () => {
  const sound = checkGalleries(world, WIN);
  assert.ok(sound.mean >= 4, `sound mean ${sound.mean}`);
  const w = broken(world);
  let galleries = sound.galleries;
  for (const bd of treeBoards()) {
    if (galleries < 4 * sound.boards) break;
    const flat = withoutGalleries(bd);
    for (let c = 0; c < 84; c++) galleries -= ((bd.links[c] >> 4) & 1) + ((bd.links[c] >> 5) & 1);
    w._set(bd.x, bd.y, flat);
  }
  const r = checkGalleries(w, WIN);
  assert.ok(r.mean < 4 && r.mean > 3.5, `mean ${r.mean}`);
  assert.equal(r.conflicts, 0);
  assert.ok(r.errors.some((e) => e.includes('galleries per board average')), r.errors.join('\n'));
  assert.deepEqual(checkTree(w, WIN).errors, []);
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
  const errors = checkGalleries(w, WIN).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): gallery 1 dir 4 overlaps another block`), errors.join('\n'));
  assert.ok(!errors.some((e) => e.includes('shares its block')), errors.join('\n'));
  // The board stays a valid tree, so only the galleries check catches it.
  assert.deepEqual(checkTree(w, WIN).errors, []);
});

test('galleries rejects a world averaging over 10 galleries per board', () => {
  const sound = checkGalleries(world, WIN);
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
  const r = checkGalleries(w, WIN);
  assert.ok(r.mean > 10 && r.mean < 10.5, `mean ${r.mean}`);
  assert.equal(r.conflicts, 0);
  assert.ok(r.errors.some((e) => e.includes('galleries per board average')), r.errors.join('\n'));
  assert.deepEqual(checkTree(w, WIN).errors, []);
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
  const r = checkCarve(full, WIN);
  assert.equal(r.mean, NCELL);
  assert.ok(r.errors.some((e) => e.includes('average 84.00')), r.errors.join('\n'));
  assert.deepEqual(checkTree(full, WIN).errors, []);
});

test('carve rejects a pruned flame cell', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => leaves(b).some((c) => world.flamesAt(b.x, b.y).includes(c)));
  const c = leaves(bd).find((u) => world.flamesAt(bd.x, bd.y).includes(u));
  w._set(bd.x, bd.y, pruned(bd, c));
  const errors = checkCarve(w, WIN).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): flame cell ${c} is pruned`), errors.join('\n'));
  // The board stays a tree, so only the carve check catches it.
  assert.deepEqual(checkTree(w, WIN).errors, []);
});

test('carve rejects a door cell stripped of its links', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => b.doors.some((d) => b.links[d.cell] && !(b.links[d.cell] & (b.links[d.cell] - 1))));
  const door = bd.doors.find((d) => bd.links[d.cell] && !(bd.links[d.cell] & (bd.links[d.cell] - 1)));
  w._set(bd.x, bd.y, pruned(bd, door.cell));
  const errors = checkCarve(w, WIN).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): door cell ${door.cell} is pruned`), errors.join('\n'));
});

test('carve rejects a board carved to 49 cells', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => b.links.filter(Boolean).length === 50 && leaves(b).length);
  const c = leaves(bd)[0];
  assert.deepEqual(checkCarve(world, WIN).errors, []);
  w._set(bd.x, bd.y, pruned(bd, c));
  const errors = checkCarve(w, WIN).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): 49 carved cells, under 50`), errors.join('\n'));
});

test('flames rejects a removed flame that opens a gap over 150 s', () => {
  // In seed 0000-0001, tomb (-1, 0), dropping entry 2's chain flame 2 leaves a 153.5 s walk.
  const base = createWorld('00000001');
  const win = tombWindow(-1, -1, 0, 0);
  assert.deepEqual(checkFlames(base, win).errors, []);
  const fs = base.tombFlames(-1, 0);
  const gone = fs.chains[1][2];
  assert.equal(gone.kind, 'route');
  const same = (f) => f.x === gone.x && f.y === gone.y && f.cell === gone.cell;
  const w = broken(base, {
    flames: new Map([['-1,0', { ...fs, chains: fs.chains.map((c) => c.filter((f) => !same(f))), flames: fs.flames.filter((f) => !same(f)) }]]),
  });
  assert.ok(!w.flamesAt(gone.x, gone.y).includes(gone.cell));
  const errors = checkFlames(w, win).errors;
  assert.ok(errors.some((e) => e.startsWith('tomb (-1,0) entry 2: flame gap 153.5 s exceeds 150 s')), errors.join('\n'));
});

test('flames rejects an entry board without a flame', () => {
  const t = world.tomb(0, 1);
  const fs = world.tombFlames(0, 1);
  const e = boardCoords(0, 1, t.entries[0], world.size);
  const entryFlames = (f) => f.x === e.x && f.y === e.y;
  // Upstream chains end on the entry board; their flames go too.
  const flames = new Map([['0,1', { ...fs, flames: fs.flames.filter((f) => !entryFlames(f)) }]]);
  for (const wl of t.walls.slice(1)) {
    const k = `${DX[wl.dir]},${1 + DY[wl.dir]}`;
    const up = world.tombFlames(...k.split(',').map(Number));
    flames.set(k, { ...up, flames: up.flames.filter((f) => !entryFlames(f)) });
  }
  const w = broken(world, { flames });
  assert.equal(w.flamesAt(e.x, e.y).length, 0);
  const errors = checkFlames(w, tombWindow(0, 0, 1, 1)).errors;
  assert.ok(errors.some((err) => err.includes(`entry board (${e.x},${e.y}) holds no flame`)), errors.join('\n'));
});

test('solvability rejects a world cut at a tomb wall', () => {
  // The walk's second tomb loses its exit door, so the way on is cut.
  const first = world.tomb(0, WIN.v0);
  const t = world.tomb(DX[first.exit], WIN.v0 + DY[first.exit]);
  assert.ok(t.v < WIN.v1);
  const x = boardCoords(t.u, t.v, t.X, world.size);
  const w = broken(world);
  const cut = copyBoard(world.board(x.x, x.y));
  cut.doors = cut.doors.filter((d) => d.dir !== t.exit);
  w._set(x.x, x.y, cut);
  const errors = checkSolvability(w, WIN).errors;
  assert.ok(errors.some((e) => e.includes('unreachable')), errors.join('\n'));
});

test('saves rejects a resumed board that differs from the board in sequence', () => {
  const bd = world.startPoint().board;
  const p = posOf(bd.x, bd.y);
  assert.deepEqual(checkSaves(world, [p]).errors, []);
  const changed = copyBoard(bd);
  setLink(changed, [...Array(84).keys()].find((i) => i % 12 < 11 && !(changed.links[i] & 1)), 0);
  const w = broken(world);
  w._set(bd.x, bd.y, changed);
  const errors = checkSaves(w, [p]).errors;
  assert.ok(errors.includes(`board at p=${p} differs when resumed`), errors.join('\n'));
});

// Per-level faults: each level's own parameters, restated apart from the
// generator and the harness.
const LADDER = {
  easy: { carve: 40, path: 16, junctions: 4, branch: 2, depth: 1 },
  medium: { carve: 45, path: 22, junctions: 6, branch: 2, depth: 2 },
  hard: { carve: 50, path: 22, junctions: 6, branch: 3, depth: 2 },
  ultimate: { carve: 50, path: 22, junctions: 6, branch: 3, depth: 2 },
};
const levels = Object.fromEntries(Object.keys(LADDER).map((d) => [d, createWorld('00000000', { difficulty: d })]));

/** Tree boards of `win`'s tombs in world `w`. */
function treeBoardsOf(w, win) {
  const out = [];
  for (let v = win.v0; v <= win.v1; v++) {
    for (let u = win.u0; u <= win.u1; u++) for (const bd of tombShape(w, u, v).boards) if (bd.links) out.push(bd);
  }
  return out;
}

/** The cell beside c in orthogonal direction d, or -1 off the grid. */
function beside(c, d) {
  const x = (c % 12) + DX[d], y = ((c / 12) | 0) + DY[d];
  return x < 0 || x >= 12 || y < 0 || y >= 7 ? -1 : y * 12 + x;
}

/** Route boards with a door at both ends of the primary path that meet the level's targets. */
function soundRouteBoards(w, win) {
  const lv = LADDER[w.difficulty];
  return treeBoardsOf(w, win).filter((bd) => bd.kind === 'route' && bd.b >= 0 && !bd.fallback
    && measureTargets(bd.links, bd.a, bd.b, bd.doors.map((d) => d.cell), lv).ok);
}

/** `bd` with a straight door-free branch of n new cells off its primary path, or null. */
function withBranch(bd, n) {
  for (const j of cellPath(bd.links, bd.a, bd.b).cells) {
    for (let d = 0; d < 4; d++) {
      const cells = [];
      for (let c = beside(j, d); cells.length < n && c >= 0 && !bd.links[c] && !bd.doorMask[c]; c = beside(c, d)) cells.push(c);
      if (cells.length < n) continue;
      const out = copyBoard(bd);
      [j, ...cells.slice(0, -1)].forEach((c) => setLink(out, c, d));
      return out;
    }
  }
  return null;
}

/** `bd` with door-free branches cut off its primary path until n junctions remain, or null. */
function withJunctions(bd, n) {
  const path = cellPath(bd.links, bd.a, bd.b).cells, on = new Set(path);
  const out = copyBoard(bd);
  const subtree = (from, root) => {
    const seen = [root];
    for (let h = 0; h < seen.length; h++) {
      for (let d = 0; d < 8; d++) {
        if (!(bd.links[seen[h]] & (1 << d))) continue;
        const t = seen[h] + DY[d] * 12 + DX[d];
        if (t !== from && !seen.includes(t)) seen.push(t);
      }
    }
    return seen;
  };
  const junctions = path.map((j) => {
    const roots = [];
    for (let d = 0; d < 8; d++) if (bd.links[j] & (1 << d) && !on.has(j + DY[d] * 12 + DX[d])) roots.push(j + DY[d] * 12 + DX[d]);
    return { j, cells: roots.flatMap((t) => subtree(j, t)) };
  }).filter((x) => x.cells.length);
  const free = junctions.filter((x) => !x.cells.some((c) => bd.doorMask[c]));
  const cut = junctions.length - n;
  if (cut < 1 || free.length < cut) return null;
  for (const { cells } of free.slice(0, cut)) {
    for (const c of cells) for (let d = 0; d < 8; d++) if (out.links[c] & (1 << d)) clearLink(out, c, d);
  }
  return out;
}

const one = (bd) => tombWindow(bd.u, bd.u, bd.v, bd.v);
const misses = (bd) => (e) => e.startsWith(`board (${bd.x},${bd.y}): misses targets`);

test('every check passes the sound world at every level, EASY on its own targets', () => {
  for (const [d, w] of Object.entries(levels)) {
    for (const check of [checkContinuity, checkTree, checkFlow, checkAcyclic, checkBounds, checkGalleries, checkCarve, checkFlames, checkSolvability]) {
      assert.deepEqual(check(w, WIN).errors, [], `${d} ${check.name}`);
    }
  }
  // EASY's boards pass on 16, 4 and 2: most miss today's 22, 6 and 3.
  const easy = treeBoardsOf(levels.easy, WIN);
  assert.equal(easy.length, 57);
  assert.equal(easy.filter((bd) => bd.junctions < 6).length, 55);
  assert.equal(easy.filter((bd) => bd.pathLen < 22).length, 31);
});

test('bounds rejects a dead-end branch one room deeper than the level allows', () => {
  for (const [d, base] of Object.entries(levels)) {
    // MEDIUM's first depth-2 room beside in-tomb rock lies in tomb (3, -1).
    const win = d === 'medium' ? tombWindow(-3, 3, -2, 2) : WIN;
    const deepest = LADDER[d].depth, w = broken(base);
    // The leaf spans all 84 cells, so the door's far cell is carved.
    const span = createWorld('00000000', { difficulty: d, carveCells: NCELL }).startPoint().board;
    // Door cells on each wall E N W S.
    const wall = [[12 + 11, 24 + 11, 36 + 11, 48 + 11, 60 + 11], [73, 74, 75, 76, 77, 78, 79, 80, 81, 82],
      [12, 24, 36, 48, 60], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]];
    let made = null;
    for (let v = win.v0; v <= win.v1 && !made; v++) {
      for (let u = win.u0; u <= win.u1 && !made; u++) {
        const shape = tombShape(base, u, v);
        shape.boards.forEach((bd, i) => {
          if (made || shape.depth[i] !== deepest) return;
          for (let k = 0; k < 4 && !made; k++) {
            const nx = bd.x + DX[k], ny = bd.y + DY[k];
            if (Math.floor(nx / base.size.w) !== u || Math.floor(ny / base.size.h) !== v || base.board(nx, ny).links) continue;
            const cell = wall[k].find((c) => bd.links[c] && !bd.doorMask[c]);
            if (cell === undefined) continue;
            const deep = copyBoard(bd);
            deep.doors.push({ dir: k, cell });
            w._set(bd.x, bd.y, deep);
            w._set(nx, ny, {
              ...copyBoard(span),
              x: nx, y: ny, p: posOf(nx, ny), u, v, kind: 'dead', fallback: true,
              doors: [{ dir: k ^ 2, cell: acrossDoor(cell, k) }],
            });
            made = { x: nx, y: ny };
          }
        });
      }
    }
    assert.ok(made, `${d}: no depth-${deepest} board borders rock`);
    const errors = checkBounds(w, win).errors;
    assert.ok(errors.some((e) => e.includes(`(${made.x},${made.y})`) && e.includes(`${deepest + 1} boards deep`)), `${d}\n${errors.join('\n')}`);
    assert.deepEqual(checkTree(w, win).errors, [], d);
  }
});

test('bounds rejects a side branch one cell under the level\'s target and accepts one at it', () => {
  for (const [d, base] of Object.entries(levels)) {
    const n = LADDER[d].branch;
    const bd = soundRouteBoards(base, WIN).find((b) => withBranch(b, n));
    assert.ok(bd, `${d}: no board takes a ${n}-cell branch`);
    for (const [len, ok] of [[n - 1, false], [n, true]]) {
      const w = broken(base);
      w._set(bd.x, bd.y, withBranch(bd, len));
      const errors = checkBounds(w, one(bd)).errors;
      if (ok) assert.deepEqual(errors, [], `${d}: a ${len}-cell branch`);
      else assert.ok(errors.some(misses(bd)) && errors.some((e) => e.includes('short 1')), `${d}: a ${len}-cell branch\n${errors.join('\n')}`);
    }
  }
});

test('bounds rejects a board left one junction under the level\'s target', () => {
  for (const [d, base] of Object.entries(levels)) {
    const n = LADDER[d].junctions - 1;
    const bd = soundRouteBoards(base, WIN).find((b) => withJunctions(b, n));
    assert.ok(bd, `${d}: no board sheds junctions down to ${n}`);
    const cut = withJunctions(bd, n);
    assert.equal(measureTargets(cut.links, cut.a, cut.b, cut.doors.map((x) => x.cell)).junctions, n, d);
    const w = broken(base);
    w._set(bd.x, bd.y, cut);
    const errors = checkBounds(w, one(bd)).errors;
    assert.ok(errors.some((e) => misses(bd)(e) && e.includes(`junctions ${n},`)), `${d}\n${errors.join('\n')}`);
  }
});

test('carve rejects a board one cell under the level\'s count, and the level\'s uncarved world', () => {
  for (const [d, base] of Object.entries(levels)) {
    const C = LADDER[d].carve, w = broken(base);
    const bd = treeBoardsOf(base, WIN).find((b) => b.links.filter(Boolean).length === C && leaves(b).length);
    assert.ok(bd, `${d}: no board holds exactly ${C} cells`);
    w._set(bd.x, bd.y, pruned(bd, leaves(bd)[0]));
    const errors = checkCarve(w, WIN).errors;
    assert.ok(errors.includes(`board (${bd.x},${bd.y}): ${C - 1} carved cells, under ${C}`), `${d}\n${errors.join('\n')}`);
    const full = checkCarve(createWorld('00000000', { difficulty: d, carveCells: NCELL }), WIN);
    assert.ok(full.errors.some((e) => e.includes('average 84.00')), d);
  }
});

test('galleries rejects a world averaging just under the level\'s floor and accepts one just above it', () => {
  for (const [d, base] of Object.entries(levels)) {
    const C = LADDER[d].carve, floor = (4 * C) / 50;
    const sound = checkGalleries(base, WIN);
    assert.ok(sound.mean >= floor, `${d}: sound mean ${sound.mean}`);
    // Flattens boards until the next one would drop the mean under the floor.
    const above = broken(base), below = broken(base);
    let galleries = sound.galleries;
    for (const bd of treeBoardsOf(base, WIN)) {
      let own = 0;
      for (let c = 0; c < 84; c++) own += ((bd.links[c] >> 4) & 1) + ((bd.links[c] >> 5) & 1);
      const flat = withoutGalleries(bd);
      below._set(bd.x, bd.y, flat);
      if (50 * (galleries - own) < 4 * C * sound.boards) break;
      above._set(bd.x, bd.y, flat);
      galleries -= own;
    }
    const hi = checkGalleries(above, WIN), lo = checkGalleries(below, WIN);
    assert.ok(hi.mean >= floor && hi.mean < floor + 0.5, `${d}: above ${hi.mean}`);
    assert.deepEqual(hi.errors, [], d);
    assert.ok(lo.mean < floor && lo.mean > floor - 0.5, `${d}: below ${lo.mean}`);
    assert.ok(lo.errors.some((e) => e.includes('galleries per board average')), `${d}\n${lo.errors.join('\n')}`);
    assert.deepEqual(checkTree(below, WIN).errors, [], d);
  }
});

test('the harness thresholds follow the carve count: carve mean C·96/100 to C·112/100, galleries 4·C/50 to 10·C/50', () => {
  assert.deepEqual(LEVELS, LADDER);
  const shown = (pairs) => pairs.map(([n, d]) => n / d);
  const got = Object.fromEntries(Object.keys(LADDER).map((d) => {
    const th = thresholds(d);
    return [d, { carveMin: th.carveMin, carveMean: shown(th.carveMean), galleries: shown(th.galleries) }];
  }));
  assert.deepEqual(got, {
    easy: { carveMin: 40, carveMean: [38.4, 44.8], galleries: [3.2, 8] },
    medium: { carveMin: 45, carveMean: [43.2, 50.4], galleries: [3.6, 9] },
    hard: { carveMin: 50, carveMean: [48, 56], galleries: [4, 10] },
    ultimate: { carveMin: 50, carveMean: [48, 56], galleries: [4, 10] },
  });
  // Integer numerators and denominators, C folded into the numerator.
  assert.deepEqual(thresholds('easy'), { carveMin: 40, carveMean: [[3840, 100], [4480, 100]], galleries: [[160, 50], [400, 50]] });
});

test('bounds passes MEDIUM\'s 4-room trunks and EASY\'s one-room trunk, and rejects a MEDIUM trunk cut to 3 rooms', () => {
  const medium = levels.medium, easy = levels.easy;
  const { w: W } = medium.size;
  const four = [];
  let cut = null;
  for (let v = -2; v <= 20 && !(four.length >= 3 && cut); v++) {
    for (let u = -3; u <= 3; u++) {
      const t = medium.tomb(u, v), r = t.routes[0];
      if (r.length === 4) four.push(t);
      // Two trunk rooms, side by side, whose door shortens the trunk to 3 rooms.
      for (let i = 0; i < r.length && !cut; i++) {
        for (let j = i + 2; j < r.length && !cut; j++) {
          const k = [0, 1, 2, 3].find((q) => r[i] + [1, W, -1, -W][q] === r[j] && Math.abs((r[i] % W) - (r[j] % W)) <= 1);
          if (k !== undefined && i + 1 + r.length - j === 3) cut = { t, i, j, k };
        }
      }
    }
  }
  assert.ok(four.length >= 3, 'MEDIUM holds 4-room trunks');
  for (const t of four) assert.deepEqual(checkBounds(medium, tombWindow(t.u, t.u, t.v, t.v)).errors, [], `MEDIUM tomb (${t.u},${t.v})`);
  assert.ok(cut, 'no MEDIUM trunk holds two rooms side by side that a door cuts to 3');
  const { t, i, j, k } = cut;
  const a = boardCoords(t.u, t.v, t.routes[0][i], medium.size), b = boardCoords(t.u, t.v, t.routes[0][j], medium.size);
  const near = medium.board(a.x, a.y), far = medium.board(b.x, b.y);
  const cell = k === 0 ? 2 * 12 + 11 : k === 2 ? 2 * 12 : k === 1 ? 72 + 1 + (a.x & 7) : 1 + (a.x & 7);
  const w = broken(medium);
  w._set(a.x, a.y, { ...copyBoard(near), doors: [...near.doors, { dir: k, cell }] });
  w._set(b.x, b.y, { ...copyBoard(far), doors: [...far.doors, { dir: k ^ 2, cell: acrossDoor(cell, k) }] });
  assert.equal(tombShape(w, t.u, t.v).routes[0].length, 3);
  const errors = checkBounds(w, tombWindow(t.u, t.u, t.v, t.v)).errors;
  assert.ok(errors.includes(`tomb (${t.u},${t.v}): trunk of 3 boards holds under the minimum of 4`), errors.join('\n'));
  // EASY: the sound world, and a tomb whose trunk is its one exit room.
  assert.deepEqual(checkBounds(easy, WIN).errors, []);
  let single = null;
  for (let v = 0; v <= 40 && !single; v++) for (let u = -5; u <= 5 && !single; u++) if (easy.tomb(u, v).entries[0] === easy.tomb(u, v).X) single = easy.tomb(u, v);
  assert.ok(single, 'no EASY tomb enters at its exit board');
  assert.deepEqual(checkBounds(easy, tombWindow(single.u, single.u, single.v, single.v)).errors, []);
});
