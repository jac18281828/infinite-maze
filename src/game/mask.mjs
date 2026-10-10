// Rock mask of one board, 576x336 px, row 0 at the top; 1 is rock. Each
// opening joins exactly the cells of one tree link or door:
// - room: cell-local [8,40) x [8,40), only for a cell that holds a link or a
//   door, so a pruned cell stays rock; corridor: the 16 px wall between rooms;
// - ladder: a 16 px shaft through the slab above the lower room's centre;
// - gallery: a 45-degree tunnel from the lower room's centre to the upper
//   room's centre, 24 px tall over its stair. A gallery's 2x2 block holds no
//   other link, so the walls and slabs it crosses hold no other passage. Its
//   air stays under the lower room's ceiling, so it meets other passages only
//   in the zone (room plus floor slab) of a cell it links.
import { BW, NCELL } from '../world/board.mjs';

export const MASK_W = 576;
export const MASK_H = 336;
export const CELL_PX = 48;

export function boardMask(bd) {
  const W = MASK_W, H = MASK_H;
  const mask = new Uint8Array(W * H).fill(1);
  const set = (x0, y0, x1, y1, v) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      const row = (H - 1 - y) * W;
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) mask[row + x] = v;
    }
  };
  if (!bd || !bd.links) return mask;
  for (let c = 0; c < NCELL; c++) {
    const X = (c % BW) * CELL_PX, Y = ((c / BW) | 0) * CELL_PX;
    const m = bd.links[c], doors = bd.doorMask[c];
    if (!m && !doors) continue;
    set(X + 8, Y + 8, X + 40, Y + 40, 0);
    if (m & 1) set(X + 40, Y + 8, X + 56, Y + 40, 0);
    if (m & 2) set(X + 16, Y + 40, X + 32, Y + 56, 0);
    if (doors & 1) set(X + 40, Y + 8, X + 48, Y + 40, 0);
    if (doors & 4) set(X, Y + 8, X + 8, Y + 40, 0);
    if (doors & 2) set(X + 16, Y + 40, X + 32, Y + 48, 0);
    if (doors & 8) set(X + 16, Y, X + 32, Y + 8, 0);
  }
  for (let c = 0; c < NCELL; c++) {
    const X = (c % BW) * CELL_PX, Y = ((c / BW) | 0) * CELL_PX;
    const m = bd.links[c];
    for (const ne of [true, false]) {
      if (!(m & (ne ? 16 : 32))) continue;
      for (let i = 0; i <= 48; i++) {
        // NE columns run right from local x 24; NW mirrors them about 23.5.
        const lx = ne ? 24 + i : 23 - i;
        const x = X + lx, f = Y + 8 + i;
        const inRoom = ne ? lx < 40 : lx >= 8;
        set(x, f + 1, x + 1, inRoom ? Math.min(f + 25, Y + 40) : f + 25, 0);
      }
    }
  }
  return mask;
}

/** True when pixel (x, y), y measured up from the board's floor, is rock. */
export function rockAt(mask, x, y) {
  return mask[(MASK_H - 1 - y) * MASK_W + x] === 1;
}
