// Each acceptance check passes a sound world and rejects one broken on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, acrossDoor, posOf } from '../src/world/world.mjs';
import { DX, DY } from '../src/world/board.mjs';
import {
  checkContinuity, checkTree, checkBounds, checkFlames, checkSolvability, checkSaves, bandShape,
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

test('every check passes the sound world', () => {
  assert.deepEqual(checkContinuity(world, B0, B1).errors, []);
  assert.deepEqual(checkTree(world, B0, B1).errors, []);
  assert.deepEqual(checkBounds(world, B0, B1).errors, []);
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
  const c = [...Array(84).keys()].find((i) => i % 12 < 11 && !(looped.links[i] & 1));
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

test('flames rejects a removed flame that opens a gap over 150 s', () => {
  // In seed 0000-01D5, band 1, dropping chain flame 3 leaves a 156.3 s walk.
  const base = createWorld('000001D5');
  const b = 1;
  assert.deepEqual(checkFlames(base, b, b).errors, []);
  const fs = base.bandFlames(b);
  const gone = fs.chain[3];
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
