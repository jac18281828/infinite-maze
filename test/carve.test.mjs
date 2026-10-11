// The carve against a reference written apart from the generator: naive trial
// cuts, each measured by the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, boardCoords, cellPath } from '../src/world/world.mjs';
import { NCELL, BW, CARVE_CELLS, DX, DY } from '../src/world/board.mjs';
import { makeHasher, worldKey, sfc32, u32 } from '../src/world/hash.mjs';
import { boardMask, rockAt, CELL_PX } from '../src/game/mask.mjs';
import { measureTargets } from '../tools/acceptance.mjs';

const CODE = '00000000';
const H = makeHasher(worldKey(CODE));
const uncarved = createWorld(CODE, { carveCells: NCELL });
const carvedWorld = createWorld(CODE);

/** Tree boards of tombs u0..u1 by v0..v1. */
function boards(world, u0, u1, v0, v1) {
  const out = [];
  for (let v = v0; v <= v1; v++) {
    for (let u = u0; u <= u1; u++) {
      for (let i = 0; i < 24; i++) {
        const { x, y } = boardCoords(u, v, i);
        const bd = world.board(x, y);
        if (bd.links) out.push(bd);
      }
    }
  }
  return out;
}

const tenTombs = boards(uncarved, -1, 0, 0, 4);
const fallbacks = boards(uncarved, -1, 1, 0, 19).filter((bd) => bd.fallback);

const nb = (c, d) => c + DY[d] * BW + DX[d];

/** Cells reachable from a, with each one's parent. */
function rooted(links, a) {
  const parent = new Map([[a, -1]]);
  const queue = [a];
  for (let h = 0; h < queue.length; h++) {
    for (let d = 0; d < 8; d++) {
      if (!(links[queue[h]] & (1 << d))) continue;
      const t = nb(queue[h], d);
      if (!parent.has(t)) { parent.set(t, queue[h]); queue.push(t); }
    }
  }
  return parent;
}

/** The carve rule's context for an uncarved board `bd`. */
function context(bd) {
  const prot = new Set(bd.doors.map((d) => d.cell));
  prot.add(bd.a);
  prot.add(bd.b);
  prot.add(u32(H('flame', bd.x, bd.y), 4) % NCELL);
  return { bd, prot, doorCells: bd.doors.map((d) => d.cell), limit: bd.deficit };
}

/** Cells of the subtree below c (c included) in the tree `parent`. */
function below(parent, c) {
  return [...parent.keys()].filter((u) => {
    for (let v = u; v >= 0; v = parent.get(v)) if (v === c) return true;
    return false;
  });
}

/**
 * The qualifying cuts of `links`, ascending by cell, each with whether it
 * removes a gallery link. `rules` switches the deficit rule off.
 */
function cuts(ctx, links, rules = {}) {
  const { bd, prot, doorCells, limit } = ctx;
  const parent = rooted(links, bd.a);
  const out = [];
  for (let c = 0; c < NCELL; c++) {
    if (c === bd.a || !parent.has(c)) continue;
    const gone = below(parent, c);
    if (gone.some((u) => prot.has(u)) || gone.length > parent.size - CARVE_CELLS) continue;
    const trial = links.slice();
    let gallery = false;
    for (const u of gone) {
      for (let d = 0; d < 8; d++) {
        if (!(trial[u] & (1 << d))) continue;
        if (d >= 4) gallery = true;
        trial[nb(u, d)] &= ~(1 << (d ^ 2));
      }
      trial[u] = 0;
    }
    if (rules.deficit !== false && measureTargets(trial, bd.a, bd.b, doorCells).deficit > limit) continue;
    out.push({ c, gallery, trial });
  }
  return out;
}

/** Carves a copy of the uncarved board `bd`; `rules` breaks one rule. */
function reference(bd, rules = {}) {
  const ctx = context(bd);
  const rng = sfc32(H('carve', bd.x, bd.y));
  let links = bd.links.slice();
  while (rooted(links, bd.a).size > CARVE_CELLS) {
    const all = cuts(ctx, links, rules);
    const free = rules.gallery === false ? [] : all.filter((cut) => !cut.gallery);
    const pool = free.length ? free : all;
    if (!pool.length) break;
    const i = rng() % pool.length;
    links = pool[rules.order === false ? pool.length - 1 - i : i].trial;
  }
  return links;
}

const same = (u, v) => u.length === v.length && u.every((m, i) => m === v[i]);

function mismatch(list, rules) {
  return list.find((bd) => !same(reference(bd, rules), carvedWorld.board(bd.x, bd.y).links));
}

test('the reference carve reproduces the generator on 238 boards of tombs u -1..0, v 0..4', () => {
  assert.equal(tenTombs.length, 238);
  const bad = mismatch(tenTombs);
  assert.equal(bad, undefined, bad && `board (${bad.x},${bad.y})`);
});

test('the reference carve reproduces the generator on every fallback board of tombs u -1..1, v 0..19', () => {
  assert.equal(fallbacks.length, 10);
  assert.equal(tenTombs.filter((bd) => bd.fallback).length, 3);
  const bad = mismatch(fallbacks);
  assert.equal(bad, undefined, bad && `board (${bad.x},${bad.y})`);
});

test('a carve that skips the deficit rule, the gallery preference or the rng order differs', () => {
  const sample = [...tenTombs, ...fallbacks];
  for (const rules of [{ deficit: false }, { gallery: false }, { order: false }]) {
    assert.ok(mismatch(sample, rules), `no board tells ${JSON.stringify(rules)} apart`);
  }
});

test('the carve is subtractive and keeps the attempt, the pair and the primary path', () => {
  for (const bd of [...tenTombs, ...fallbacks]) {
    const cv = carvedWorld.board(bd.x, bd.y);
    const at = `board (${bd.x},${bd.y})`;
    assert.equal(cv.k, bd.k, at);
    assert.equal(cv.fallback, bd.fallback, at);
    assert.equal(cv.a, bd.a, at);
    assert.equal(cv.b, bd.b, at);
    assert.deepEqual(cellPath(cv.links, cv.a, cv.b), cellPath(bd.links, bd.a, bd.b), at);
    for (let c = 0; c < NCELL; c++) assert.equal(cv.links[c] & ~bd.links[c], 0, `${at} cell ${c}`);
    assert.ok(rooted(cv.links, cv.a).size >= CARVE_CELLS, at);
    assert.ok(cv.deficit <= bd.deficit, at);
    // The record's figures describe the carved tree.
    const m = measureTargets(cv.links, cv.a, cv.b, cv.doors.map((d) => d.cell));
    assert.deepEqual([cv.pathLen, cv.junctions, cv.deficit], [m.pathLen, m.junctions, m.deficit], at);
  }
});

test('a board holding more than 50 cells has no qualifying cut left', () => {
  let over = 0;
  for (const bd of [...tenTombs, ...fallbacks]) {
    const cv = carvedWorld.board(bd.x, bd.y);
    if (rooted(cv.links, cv.a).size <= CARVE_CELLS) continue;
    over++;
    assert.deepEqual(cuts(context(bd), cv.links).map((cut) => cut.c), [], `board (${bd.x},${bd.y})`);
  }
  assert.ok(over > 0, 'no board stops above 50 cells');
});

test('the mask opens the room of a carved cell and keeps a pruned cell solid', () => {
  let pruned = 0, open = 0;
  for (const bd of boards(carvedWorld, -1, 0, 0, 2)) {
    const mask = boardMask(bd);
    for (let c = 0; c < NCELL; c++) {
      const X = (c % BW) * CELL_PX, Y = ((c / BW) | 0) * CELL_PX;
      const held = bd.links[c] !== 0 || bd.doorMask[c] !== 0;
      let solid = 0;
      for (let y = Y + 8; y < Y + 40; y++) for (let x = X + 8; x < X + 40; x++) if (rockAt(mask, x, y)) solid++;
      assert.equal(solid, held ? 0 : 32 * 32, `board (${bd.x},${bd.y}) cell ${c}`);
      if (held) open++; else pruned++;
    }
  }
  assert.ok(pruned > 0 && open > 0);
});
