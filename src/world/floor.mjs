// Floor items: things that lie on the floor of a dead-end cell, placed by hash
// off a built board. The layer builds nothing into a board, so no world digest
// depends on it. A new kind is one more row of FLOOR_ITEMS.
import { u32 } from './hash.mjs';
import { BW, NCELL, DX } from './board.mjs';

// In order: a dead-end cell takes the first kind whose hash passes `percent`,
// so two items never share a cell.
export const FLOOR_ITEMS = [
  { kind: 'coin', tag: 'coin', percent: 5 },
];

// Board geometry in world pixels, as the game's nodeXY lays it out: a cell is
// 48 px, its standing point 24 px across and 8 px up.
const CELL_PX = 48;
const BOARD_PX_W = BW * CELL_PX;
const BOARD_PX_H = (NCELL / BW) * CELL_PX;
// An item rests this far from its cell's standing point, away from the link.
const SPOT_OFFSET = 12;

/** The carved cells of tree board `bd` with one link, no door and no flame, ascending. */
export function deadEnds(world, bd) {
  if (!bd.links) return [];
  const flames = new Set(world.flamesAt(bd.x, bd.y));
  const cells = [];
  for (let cell = 0; cell < NCELL; cell++) {
    const links = bd.links[cell];
    if (links !== 0 && (links & (links - 1)) === 0 && bd.doorMask[cell] === 0 && !flames.has(cell)) cells.push(cell);
  }
  return cells;
}

const cache = new WeakMap();

/**
 * The items of board `bd` as { cell, kind }, ascending by cell; a rock board
 * has none. The default list is computed once per board object.
 */
export function floorItems(world, bd, items = FLOOR_ITEMS) {
  const cached = items === FLOOR_ITEMS ? cache.get(bd) : undefined;
  if (cached) return cached;
  const out = [];
  for (const cell of deadEnds(world, bd)) {
    const item = items.find((it) => u32(world.H(it.tag, bd.x, bd.y, cell)) % 100 < it.percent);
    if (item) out.push({ cell, kind: item.kind });
  }
  if (items === FLOOR_ITEMS) cache.set(bd, out);
  return out;
}

/**
 * The floor point of the item on dead-end `cell`, in world pixels: 12 px from
 * the cell's standing point on the side away from its one link, or east of a
 * ladder. That clears the corridor mouth, the ladder shaft and the stair.
 */
export function itemSpot(bd, cell) {
  const d = 31 - Math.clz32(bd.links[cell] & -bd.links[cell]);
  const dx = DX[d] === 0 ? SPOT_OFFSET : -SPOT_OFFSET * DX[d];
  return [
    bd.x * BOARD_PX_W + (cell % BW) * CELL_PX + CELL_PX / 2 + dx,
    bd.y * BOARD_PX_H + ((cell / BW) | 0) * CELL_PX + 8,
  ];
}
