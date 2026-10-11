// The pause-screen map: what the explorer's trail shows of one tomb. DOM-free.
// The model holds the walked links, the openings of stood cells, the entered
// boards, the flames at stood cells and the explorer; it never names a cell
// the explorer did not stand on or a passage beyond a stub.
import { BW, BH, NCELL } from '../world/board.mjs';
import { BANDW, BANDH } from '../world/band.mjs';
import { tombOf } from '../world/world.mjs';

/** Frame size in cells for a tomb of `size` boards of 12x7 cells. */
export function mapCells(size) {
  return { cols: size.w * BW, rows: size.h * BH };
}

// Each link is listed once, from the end whose direction is one of these.
const LINE_DIRS = [0, 1, 4, 5];

/** The tomb { u, v } that holds board `bd`. */
export function frameOf(bd) {
  return tombOf(bd.x, bd.y);
}

/** The frame one tomb on in the direction of pan key `dir`: 'l', 'r', 'u' or 'd'. */
export function panFrame(f, dir) {
  return { u: f.u + (dir === 'r' ? 1 : dir === 'l' ? -1 : 0), v: f.v + (dir === 'u' ? 1 : dir === 'd' ? -1 : 0) };
}

/** True when frames f and g name the same tomb. */
export function sameFrame(f, g) {
  return f.u === g.u && f.v === g.v;
}

/**
 * Lines, stubs, outlines, flames and the explorer of tomb `f`, in frame
 * cells: column (x - 6u) * 12 + cell % 12, row (y - 4v) * 7 + floor(cell /
 * 12), row 0 at the bottom. `at` is the explorer's { bd, cell }.
 */
export function mapModel(world, trail, f, at) {
  const lines = [], stubs = [], outlines = [], flames = [];
  const x0 = BANDW * f.u, y0 = BANDH * f.v;
  const inFrame = (x, y) => x >= x0 && x < x0 + BANDW && y >= y0 && y < y0 + BANDH;
  const cellAt = (bd, cell) => ({ col: (bd.x - x0) * BW + (cell % BW), row: (bd.y - y0) * BH + ((cell / BW) | 0) });
  const boards = [...trail.values()].filter((t) => inFrame(t.x, t.y)).sort((p, q) => p.y - q.y || p.x - q.x);
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
        if (LINE_DIRS.includes(d) && inFrame(to.board.x, to.board.y)) lines.push({ ...here, d });
      }
    }
    if (entered) outlines.push({ ...cellAt(bd, 0), gaps });
  }
  const explorer = at && inFrame(at.bd.x, at.bd.y) ? cellAt(at.bd, at.cell) : null;
  return { lines, stubs, outlines, flames, explorer };
}
