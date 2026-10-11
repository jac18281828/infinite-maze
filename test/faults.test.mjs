// Each acceptance check passes a sound world and rejects one broken on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, acrossDoor, posOf, cellPath, boardCoords } from '../src/world/world.mjs';
import { DX, DY, NCELL } from '../src/world/board.mjs';
import {
  checkContinuity, checkTree, checkFlow, checkAcyclic, checkBounds, checkGalleries, checkCarve, checkFlames,
  checkSolvability, checkSaves, checkWayUp, tombShape, tombWindow, WAY_UP_CAP,
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

const easy = createWorld('00000000', { difficulty: 'easy' });

test('bounds passes the sound EASY world, a one-board trunk included, and rejects an EASY trunk of 2 rooms', () => {
  assert.deepEqual(checkBounds(easy, WIN).errors, []);
  const { w: W } = easy.size;
  let one = null, cut = null;
  for (let v = 0; v <= 40 && !(one && cut); v++) {
    for (let u = -5; u <= 5; u++) {
      const t = easy.tomb(u, v);
      if (!one && t.entries[0] === t.X) one = t;
      // A trunk of 3 or more whose first entry borders X off the trunk: a door between them cuts it to 2 rooms.
      const e = t.routes[0][0];
      const d = [0, 1, 2, 3].find((q) => e + [1, W, -1, -W][q] === t.X && Math.abs((e % W) - (t.X % W)) <= 1);
      if (!cut && t.routes[0].length >= 3 && d !== undefined) cut = { t, d };
    }
  }
  assert.ok(one, 'no EASY tomb enters at its exit board');
  assert.deepEqual(checkBounds(easy, tombWindow(one.u, one.u, one.v, one.v)).errors, []);
  assert.ok(cut, 'no EASY tomb has a first entry beside its exit board off the trunk');
  const { t, d } = cut;
  const a = boardCoords(t.u, t.v, t.routes[0][0], easy.size), b = boardCoords(t.u, t.v, t.X, easy.size);
  const near = easy.board(a.x, a.y), far = easy.board(b.x, b.y);
  const cell = d === 0 ? 2 * 12 + 11 : d === 2 ? 2 * 12 : d === 1 ? 72 + 1 + (a.x & 7) : 1 + (a.x & 7);
  const w = broken(easy);
  w._set(a.x, a.y, { ...copyBoard(near), doors: [...near.doors, { dir: d, cell }] });
  w._set(b.x, b.y, { ...copyBoard(far), doors: [...far.doors, { dir: d ^ 2, cell: acrossDoor(cell, d) }] });
  const win = tombWindow(t.u, t.u, t.v, t.v);
  assert.equal(tombShape(w, t.u, t.v).routes[0].length, 2);
  const errors = checkBounds(w, win).errors;
  assert.ok(errors.includes(`tomb (${t.u},${t.v}): trunk of 2 boards holds under half of 6`), errors.join('\n'));
});
