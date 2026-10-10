// Each acceptance check passes a sound world and rejects one broken on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, acrossDoor, posOf, cellPath } from '../src/world/world.mjs';
import { DX, DY, NCELL } from '../src/world/board.mjs';
import {
  checkContinuity, checkTree, checkBounds, checkGalleries, checkCarve, checkFlames, checkSolvability, checkSaves,
  bandShape,
} from '../tools/acceptance.mjs';

const B0 = -2, B1 = 2;
const world = createWorld('00000000');

/** A view of `world` with some boards and flames replaced. */
function broken(base, { boards = new Map(), flames = new Map() } = {}) {
  const key = (x, y) => `${x},${y}`;
  return {
    ...base,
    board: (x, y) => boards.get(key(x, y)) ?? base.board(x, y),
    bandFlames: (b) => flames.get(b) ?? base.bandFlames(b),
    flamesAt: (x, y) => {
      let cells = base.flamesAt(x, y);
      for (const [fb, fs] of flames) {
        const orig = base.bandFlames(fb);
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

/** Tree boards of bands B0..B1. */
function treeBoards() {
  const out = [];
  for (let b = B0; b <= B1; b++) for (const bd of bandShape(world, b).boards) if (bd.links) out.push(bd);
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
  assert.deepEqual(checkContinuity(world, B0, B1).errors, []);
  assert.deepEqual(checkTree(world, B0, B1).errors, []);
  assert.deepEqual(checkBounds(world, B0, B1).errors, []);
  assert.deepEqual(checkGalleries(world, B0, B1).errors, []);
  assert.deepEqual(checkCarve(world, B0, B1).errors, []);
  assert.deepEqual(checkFlames(world, B0, B1).errors, []);
  assert.deepEqual(checkSolvability(world, B0, B1).errors, []);
});

test('continuity rejects a door moved on one side of its wall', () => {
  const w = broken(world);
  const shape = bandShape(world, 0);
  const bd = shape.boards.find((b) => b.links && b.doors.some((d) => d.dir === 0));
  const moved = copyBoard(bd);
  const door = moved.doors.find((d) => d.dir === 0);
  const row = (door.cell / 12) | 0;
  door.cell = (row === 5 ? 1 : row + 1) * 12 + 11;
  w._set(bd.x, bd.y, moved);
  const errors = checkContinuity(w, B0, B1).errors;
  assert.ok(errors.some((e) => e.includes(`board (${bd.x},${bd.y})`) && e.includes('no partner')), errors.join('\n'));
});

test('tree rejects an extra link that closes a loop', () => {
  const w = broken(world);
  const bd = world.board(world.tree(0).entryX, 0);
  const looped = copyBoard(bd);
  // Two carved east neighbours that no link joins; the tree already joins them.
  const c = [...Array(84).keys()].find((i) => i % 12 < 11 && looped.links[i] && looped.links[i + 1] && !(looped.links[i] & 1));
  setLink(looped, c, 0);
  w._set(bd.x, bd.y, looped);
  const errors = checkTree(w, B0, B1).errors;
  assert.ok(errors.some((e) => e.startsWith('band 0:') && e.includes('edges for')), errors.join('\n'));
});

test('tree rejects a second door between bands', () => {
  const w = broken(world);
  let added = false;
  for (let x = 0; x < 6 && !added; x++) {
    const top = world.board(x, -1), bottom = world.board(x, 0);
    if (!top.links || !bottom.links || bottom.doors.some((d) => d.dir === 3)) continue;
    const t = copyBoard(top), u = copyBoard(bottom);
    const col = 1 + ((x + 3) % 10);
    t.doors.push({ dir: 1, cell: 72 + col });
    u.doors.push({ dir: 3, cell: col });
    w._set(x, -1, t);
    w._set(x, 0, u);
    added = true;
  }
  assert.ok(added, 'no column holds two tree boards across the band seam');
  const errors = checkTree(w, B0, B1).errors;
  assert.ok(errors.some((e) => e.startsWith('bands -1/0:')), errors.join('\n'));
});

test('bounds rejects a dead-end branch 3 boards deep', () => {
  const w = broken(world);
  let made = null;
  for (let b = B0; b <= B1 && !made; b++) {
    const shape = bandShape(world, b);
    shape.boards.forEach((bd, i) => {
      if (made || shape.depth[i] !== 2) return;
      for (let d = 0; d < 4 && !made; d++) {
        const nx = bd.x + DX[d], ny = bd.y + DY[d];
        if (nx < 0 || nx > 5 || Math.floor(ny / 4) !== b) continue;
        const rock = world.board(nx, ny);
        if (rock.links) continue;
        const cell = d === 0 ? 3 * 12 + 11 : d === 2 ? 3 * 12 : d === 1 ? 72 + 5 : 5;
        const deep = copyBoard(bd);
        deep.doors.push({ dir: d, cell });
        const leaf = {
          ...copyBoard(world.board(world.tree(b).entryX, 4 * b)),
          x: nx, y: ny, p: 6 * ny + nx, kind: 'dead', fallback: true,
          doors: [{ dir: d ^ 2, cell: acrossDoor(cell, d) }],
        };
        w._set(bd.x, bd.y, deep);
        w._set(nx, ny, leaf);
        made = { x: nx, y: ny };
      }
    });
  }
  assert.ok(made, 'no depth-2 board borders rock');
  const errors = checkBounds(w, B0, B1).errors;
  assert.ok(errors.some((e) => e.includes(`(${made.x},${made.y})`) && e.includes('3 boards deep')), errors.join('\n'));
  // The deeper board still forms a valid tree, so only bounds can catch it.
  assert.deepEqual(checkTree(w, B0, B1).errors, []);
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
  assert.deepEqual(checkTree(w, B0, B1).errors, []);
  // Lowering the 2,000-board threshold below this world's size enforces the ceiling.
  const errors = checkBounds(w, B0, B1, boards).errors;
  assert.ok(errors.some((e) => e.includes('ceiling') && /\(\d+\.\d%\)/.test(e)), errors.join('\n'));
  assert.deepEqual(checkBounds(world, B0, B1, boards).errors, []);
});

test('bounds reports a fallback rate over the ceiling on a run under 2,000 boards', () => {
  const w = withFallbacks(Math.ceil(treeBoards().length / 20));
  const r = checkBounds(w, B0, B1);
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
    if (checkBounds(w, B0, B1).errors.length === 0) { found = { bd, c, w }; break; }
  }
  assert.ok(found, 'no board with a north-east gallery survives the tangle');
  const { bd, c, w } = found;
  const errors = checkGalleries(w, B0, B1).errors;
  assert.ok(errors.some((e) => e.startsWith(`board (${bd.x},${bd.y}): gallery ${c}`) && e.includes('shares its block')), errors.join('\n'));
  // The board stays a valid tree, so only the galleries check catches it.
  assert.deepEqual(checkTree(w, B0, B1).errors, []);
  assert.deepEqual(checkBounds(w, B0, B1).errors, []);
});

test('galleries rejects a world averaging under 4 galleries per board', () => {
  const sound = checkGalleries(world, B0, B1);
  assert.ok(sound.mean >= 4, `sound mean ${sound.mean}`);
  const w = broken(world);
  let galleries = sound.galleries;
  for (const bd of treeBoards()) {
    if (galleries < 4 * sound.boards) break;
    const flat = withoutGalleries(bd);
    for (let c = 0; c < 84; c++) galleries -= ((bd.links[c] >> 4) & 1) + ((bd.links[c] >> 5) & 1);
    w._set(bd.x, bd.y, flat);
  }
  const r = checkGalleries(w, B0, B1);
  assert.ok(r.mean < 4 && r.mean > 3.5, `mean ${r.mean}`);
  assert.equal(r.conflicts, 0);
  assert.ok(r.errors.some((e) => e.includes('galleries per board average')), r.errors.join('\n'));
  assert.deepEqual(checkTree(w, B0, B1).errors, []);
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
  const errors = checkGalleries(w, B0, B1).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): gallery 1 dir 4 overlaps another block`), errors.join('\n'));
  assert.ok(!errors.some((e) => e.includes('shares its block')), errors.join('\n'));
  // The board stays a valid tree, so only the galleries check catches it.
  assert.deepEqual(checkTree(w, B0, B1).errors, []);
});

test('galleries rejects a world averaging over 10 galleries per board', () => {
  const sound = checkGalleries(world, B0, B1);
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
  const r = checkGalleries(w, B0, B1);
  assert.ok(r.mean > 10 && r.mean < 10.5, `mean ${r.mean}`);
  assert.equal(r.conflicts, 0);
  assert.ok(r.errors.some((e) => e.includes('galleries per board average')), r.errors.join('\n'));
  assert.deepEqual(checkTree(w, B0, B1).errors, []);
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
  const r = checkCarve(full, B0, B1);
  assert.equal(r.mean, NCELL);
  assert.ok(r.errors.some((e) => e.includes('average 84.00')), r.errors.join('\n'));
  assert.deepEqual(checkTree(full, B0, B1).errors, []);
});

test('carve rejects a pruned flame cell', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => leaves(b).some((c) => world.flamesAt(b.x, b.y).includes(c)));
  const c = leaves(bd).find((u) => world.flamesAt(bd.x, bd.y).includes(u));
  w._set(bd.x, bd.y, pruned(bd, c));
  const errors = checkCarve(w, B0, B1).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): flame cell ${c} is pruned`), errors.join('\n'));
  // The board stays a tree, so only the carve check catches it.
  assert.deepEqual(checkTree(w, B0, B1).errors, []);
});

test('carve rejects a door cell stripped of its links', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => b.doors.some((d) => b.links[d.cell] && !(b.links[d.cell] & (b.links[d.cell] - 1))));
  const door = bd.doors.find((d) => bd.links[d.cell] && !(bd.links[d.cell] & (bd.links[d.cell] - 1)));
  w._set(bd.x, bd.y, pruned(bd, door.cell));
  const errors = checkCarve(w, B0, B1).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): door cell ${door.cell} is pruned`), errors.join('\n'));
});

test('carve rejects a board carved to 49 cells', () => {
  const w = broken(world);
  const bd = treeBoards().find((b) => b.links.filter(Boolean).length === 50 && leaves(b).length);
  const c = leaves(bd)[0];
  assert.deepEqual(checkCarve(world, B0, B1).errors, []);
  w._set(bd.x, bd.y, pruned(bd, c));
  const errors = checkCarve(w, B0, B1).errors;
  assert.ok(errors.includes(`board (${bd.x},${bd.y}): 49 carved cells, under 50`), errors.join('\n'));
});

test('flames rejects a removed flame that opens a gap over 150 s', () => {
  // In seed 0000-0013, band 2, dropping chain flame 2 leaves a 152.9 s walk.
  const base = createWorld('00000013');
  const b = 2;
  assert.deepEqual(checkFlames(base, b, b).errors, []);
  const fs = base.bandFlames(b);
  const gone = fs.chain[2];
  assert.equal(gone.kind, 'route');
  const w = broken(base, {
    flames: new Map([[b, { ...fs, chain: fs.chain.filter((f) => f !== gone), flames: fs.flames.filter((f) => f !== gone) }]]),
  });
  assert.ok(!w.flamesAt(gone.x, gone.y).includes(gone.cell));
  const errors = checkFlames(w, b, b).errors;
  assert.ok(errors.some((e) => e.includes('exceeds 150 s')), errors.join('\n'));
});

test('flames rejects a band entry without a flame', () => {
  const t = world.tree(1);
  const fs = world.bandFlames(1);
  const entryFlame = fs.chain[0];
  const w = broken(world, {
    flames: new Map([[1, { ...fs, flames: fs.flames.filter((f) => f !== entryFlame) }]]),
  });
  assert.equal(w.flamesAt(t.entryX, 4).length, 0);
  const errors = checkFlames(w, 1, 1).errors;
  assert.ok(errors.some((e) => e.includes('entry holds no flame')), errors.join('\n'));
});

test('solvability rejects a world cut at a band seam', () => {
  const w = broken(world);
  const bd = world.board(world.tree(1).entryX, 4);
  const cut = copyBoard(bd);
  cut.doors = cut.doors.filter((d) => d.dir !== 3);
  w._set(bd.x, bd.y, cut);
  const errors = checkSolvability(w, B0, B1).errors;
  assert.ok(errors.some((e) => e.includes('unreachable')), errors.join('\n'));
});

test('saves rejects a resumed board that differs from the board in sequence', () => {
  const t = world.tree(0);
  const p = posOf(t.entryX, 0);
  assert.deepEqual(checkSaves(world, [p]).errors, []);
  const bd = world.board(t.entryX, 0);
  const changed = copyBoard(bd);
  setLink(changed, [...Array(84).keys()].find((i) => i % 12 < 11 && !(changed.links[i] & 1)), 0);
  const w = broken(world);
  w._set(bd.x, bd.y, changed);
  const errors = checkSaves(w, [p]).errors;
  assert.ok(errors.includes(`board at p=${p} differs when resumed`), errors.join('\n'));
});
