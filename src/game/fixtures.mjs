// Pixel geometry of a board's drawn fixtures and of the dust, DOM-free. Board
// pixels, y up: X = col * 48, Y = row * 48. A north-east flight from cell c
// has t = x - (X + 24) over [X + 24, X + 72); a north-west flight mirrors
// every x to 2X + 47 - x. Mask rows count down from the top, as in mask.mjs.
import { BW, NCELL } from '../world/board.mjs';
import { boardMask, MASK_W, MASK_H, CELL_PX } from './mask.mjs';
import { LADDER, SCONCE, idx } from './art.mjs';

export const STEPS = 12;
export const STEP_W = 4;
// Stair pixel roles: a column's top pixel, a step's left face, the rest.
export const ROLE = { tread: 1, riser: 2, body: 3 };

/** First row of step k's tread: 4 px over the lower floor, flush at the top. */
function treadRow(Y, k) {
  return Y + 11 + STEP_W * k;
}

/** Top row of the rock under column t of a flight: the room floor, then the gallery's edge. */
function supportRow(Y, t) {
  return t < 16 ? Y + 7 : Y + 8 + t;
}

/** Board x of column t of a flight from cell origin X, rising toward `dir`. */
function stairX(X, t, dir) {
  return dir > 0 ? X + 24 + t : X + 23 - t;
}

/** Board row (y up) to mask row. */
export function maskRow(y) {
  return MASK_H - 1 - y;
}

/** Runs of one flight: each column's mask air from its tread down to the row above its support. */
function flightRuns(X, Y, dir, mask) {
  const runs = [];
  for (let t = 0; t < STEPS * STEP_W; t++) {
    const x = stairX(X, t, dir);
    const treadTop = treadRow(Y, (t / STEP_W) | 0), lo = supportRow(Y, t) + 1;
    const air = (y) => x >= 0 && x < MASK_W && y >= 0 && y < MASK_H && !mask[maskRow(y) * MASK_W + x];
    for (let y = treadTop; y >= lo; y--) {
      if (!air(y)) continue;
      let bot = y;
      while (bot > lo && air(bot - 1)) bot--;
      runs.push({ t, x, top: y, bot, tread: y === treadTop });
      y = bot;
    }
  }
  return runs;
}

/** Opaque pixels of a sprite drawn with its top left at board (x, yTop), yTop the top row. */
function spritePixels(rows, x, yTop) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) if (idx(rows[r][c]) >= 0) out.push([x + c, yTop - r]);
  }
  return out;
}

/**
 * Opaque pixels of a ladder box [x, x + 16) x [y0, y1): the sprite repeats in
 * 8-row chunks from y0, the last chunk keeping the sprite's top rows.
 */
export function ladderPixels([x, y0, y1]) {
  const out = [];
  for (let y = y0; y < y1; y += 8) {
    const h = Math.min(8, y1 - y);
    out.push(...spritePixels(LADDER.slice(0, h), x, y + h - 1));
  }
  return out;
}

/** Opaque pixels of the sconce centred on cx whose row `y` is the sprite's top edge. */
export function sconcePixels([cx, y]) {
  return spritePixels(SCONCE, cx - 4, y - 1);
}

/** Ladder boxes [x, y0, y1) of cell c. Where a gallery starts in a cell, its ladder ends at the floor. */
function cellLadders(bd, c) {
  const X = (c % BW) * CELL_PX, Y = ((c / BW) | 0) * CELL_PX;
  const m = bd.links[c], doors = bd.doorMask[c];
  const gallery = (cell) => cell < NCELL && (bd.links[cell] & 48) !== 0;
  const out = [];
  if (m & 2) out.push([X + 16, Y + 8, gallery(c + BW) ? Y + 56 : Y + 64]);
  if (doors & 2) out.push([X + 16, Y + 8, Y + 48]);
  if (doors & 8) out.push([X + 16, Y, gallery(c) ? Y + 8 : Y + 14]);
  return out;
}

/** Sconce [centre x, y] of cell c, or null. A bottom door's moves clear of a north-east stair. */
function cellSconce(bd, c) {
  const X = (c % BW) * CELL_PX, Y = ((c / BW) | 0) * CELL_PX;
  const m = bd.links[c], doors = bd.doorMask[c];
  if (!doors) return null;
  let x = doors & 4 ? X + 13 : doors & 1 ? X + 35 : X + 36;
  if (x === X + 36 && doors & 8 && m & 16) x = X + 12;
  return [x, Y + 26];
}

/**
 * Stairs, ladders and sconces of board `bd`:
 * - flights: each stair's cell, origin and direction, with its pixel runs: a
 *   column t at board x holds rows bot..top, `tread` when top is the tread;
 * - stairs: role per mask pixel (ROLE), 0 elsewhere;
 * - ladders: [x, y0, y1) boxes;
 * - sconces: [centre x, y].
 */
export function fixtureSets(bd, mask = boardMask(bd)) {
  const flights = [], ladders = [], sconces = [];
  const stairs = new Uint8Array(MASK_W * MASK_H);
  for (let c = 0; c < NCELL; c++) {
    const X = (c % BW) * CELL_PX, Y = ((c / BW) | 0) * CELL_PX;
    ladders.push(...cellLadders(bd, c));
    const sconce = cellSconce(bd, c);
    if (sconce) sconces.push(sconce);
    for (const dir of [1, -1]) {
      if (!(bd.links[c] & (dir > 0 ? 16 : 32))) continue;
      const runs = flightRuns(X, Y, dir, mask);
      flights.push({ c, X, Y, dir, runs });
      for (const { t, x, top, bot, tread } of runs) {
        for (let y = bot; y <= top; y++) {
          stairs[maskRow(y) * MASK_W + x] = tread && y === top ? ROLE.tread : t % STEP_W === 0 ? ROLE.riser : ROLE.body;
        }
      }
    }
  }
  return { flights, stairs, ladders, sconces };
}

// One mote per 25 x 20 px lattice cell: a mean of 48 per 200 x 120 px window,
// and sampled windows hold 40 to 56. A mote sways inside a patch around its home.
export const MOTE_W = 25;
export const MOTE_H = 20;
export const SWAY_X = 6;
export const SWAY_Y = 8;

function mix(a, b, c) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1013904223)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Motes inside world rectangle [x0, x1) x [y0, y1) at time `t`. A mote is
 * { x, y, hx, hy }: its place and its home, which moves only with the offset
 * (ox, oy). Place depends on nothing else, so any two rectangles agree.
 */
export function dustMotes(x0, y0, x1, y1, t, ox = 0, oy = 0) {
  const out = [];
  const i0 = Math.floor((x0 - ox - SWAY_X) / MOTE_W), i1 = Math.floor((x1 - ox + SWAY_X) / MOTE_W);
  const j0 = Math.floor((y0 - oy - SWAY_Y) / MOTE_H), j1 = Math.floor((y1 - oy + SWAY_Y) / MOTE_H);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const hx = i * MOTE_W + (mix(i, j, 1) % MOTE_W) + ox, hy = j * MOTE_H + (mix(i, j, 2) % MOTE_H) + oy;
      const ph = (mix(i, j, 3) % 628) / 100, v = 2 + (mix(i, j, 4) % 7);
      const x = hx + Math.sin(t * 0.7 + ph) * SWAY_X, y = hy + Math.sin(t * v * 0.15 + ph * 1.7) * SWAY_Y;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) out.push({ x, y, hx, hy });
    }
  }
  return out;
}
