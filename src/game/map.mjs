// The pause-screen map: what the explorer's trail shows of one tower band.
// DOM-free. The model holds the walked links, the openings of stood cells,
// the entered boards, the flames at stood cells and the explorer; it never
// names a cell the explorer did not stand on or a passage beyond a stub.
import { BW, BH, NCELL } from '../world/board.mjs';
import { DIFFICULTY } from '../world/band.mjs';
import { bandOf } from '../world/world.mjs';

/** Frame size in cells for a tomb of `size` boards of 12x7 cells. */
export function mapCells(size) {
  return { cols: size.w * BW, rows: size.h * BH };
}

// Each link is listed once, from the end whose direction is one of these.
const LINE_DIRS = [0, 1, 4, 5];

/** The band that holds board `bd` in a tomb of `size` boards. */
export function frameOf(bd, size = DIFFICULTY.hard) {
  return bandOf(bd.y, size);
}

/** The frame after a pan key `dir` ('l', 'r', 'u' or 'd'); the tower is one band wide. */
export function panFrame(b, dir) {
  return dir === 'u' ? b + 1 : dir === 'd' ? b - 1 : b;
}

/**
 * Lines, stubs, outlines, flames and the explorer of band `b`, in frame
 * cells: column x * 12 + cell % 12, row (y - Hb) * 7 + floor(cell / 12), row
 * 0 at the bottom, for the world's tomb height H. `at` is the explorer's
 * { bd, cell }.
 */
export function mapModel(world, trail, b, at) {
  const lines = [], stubs = [], outlines = [], flames = [];
  const y0 = world.size.h * b;
  const inBand = (y) => y >= y0 && y < y0 + world.size.h;
  const cellAt = (bd, cell) => ({ col: bd.x * BW + (cell % BW), row: (bd.y - y0) * BH + ((cell / BW) | 0) });
  const boards = [...trail.values()].filter((t) => inBand(t.y)).sort((p, q) => p.y - q.y || p.x - q.x);
  for (const t of boards) {
    const bd = world.board(t.x, t.y);
    if (!bd.links) continue;
    const flameCells = world.flamesAt(t.x, t.y);
    const gaps = [];
    let entered = false;
    for (let cell = 0; cell < NCELL; cell++) {
      if (!t.stood[cell]) continue;
      entered = true;
      const here = cellAt(bd, cell);
      if (flameCells.includes(cell)) flames.push(here);
      for (let d = 0; d < 8; d++) {
        const to = world.step(bd, cell, d);
        if (!to) continue;
        if (!(t.walked[cell] & (1 << d))) { stubs.push({ ...here, d }); continue; }
        if (d < 4 && !(bd.links[cell] & (1 << d))) gaps.push({ ...here, d });
        if (LINE_DIRS.includes(d) && inBand(to.board.y)) lines.push({ ...here, d });
      }
    }
    if (entered) outlines.push({ ...cellAt(bd, 0), gaps });
  }
  const explorer = at && inBand(at.bd.y) ? cellAt(at.bd, at.cell) : null;
  return { lines, stubs, outlines, flames, explorer };
}
