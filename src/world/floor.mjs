// Floor items: things that lie on the floor of a dead-end cell, placed by hash
// off a built board. The layer builds nothing into a board, so no world digest
// depends on it. A new kind is one more row of FLOOR_ITEMS.
import { u32 } from './hash.mjs';
import { BW, NCELL, DX } from './board.mjs';

// Oil jars per tree board, by the world's difficulty.
export const OIL_COUNT = { easy: 2, medium: 1, hard: 1, ultimate: 1 };

// In list order, each row claims cells from the dead ends the rows before it
// left, so two items never share a cell. A `percent` row takes each such cell
// whose hash passes; a `count` row takes that many by lowest hash, the lower
// cell winning a tie, or every such cell when fewer remain. Either field is a
// number or a table keyed by difficulty.
export const FLOOR_ITEMS = [
  { kind: 'coin', tag: 'coin', percent: 5 },
  { kind: 'oil', tag: 'oil', count: OIL_COUNT },
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

const byDifficulty = (v, world) => (typeof v === 'number' ? v : v[world.difficulty]);

const cache = new WeakMap();

/**
 * The items of board `bd` as { cell, kind }, ascending by cell; a rock board
 * has none. The default list is computed once per board object.
 */
export function floorItems(world, bd, items = FLOOR_ITEMS) {
  const cached = items === FLOOR_ITEMS ? cache.get(bd) : undefined;
  if (cached) return cached;
  const out = [];
  let free = deadEnds(world, bd);
  for (const it of items) {
    const hash = (cell) => u32(world.H(it.tag, bd.x, bd.y, cell));
    let taken;
    if (it.count !== undefined) {
      const rank = new Map(free.map((cell) => [cell, hash(cell)]));
      taken = [...free].sort((a, b) => rank.get(a) - rank.get(b) || a - b).slice(0, byDifficulty(it.count, world));
    } else {
      const percent = byDifficulty(it.percent, world);
      taken = free.filter((cell) => hash(cell) % 100 < percent);
    }
    for (const cell of taken) out.push({ cell, kind: it.kind });
    const gone = new Set(taken);
    free = free.filter((cell) => !gone.has(cell));
  }
  out.sort((a, b) => a.cell - b.cell);
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

// Coin rows: three coins on the floor of the corridor east of a cell, chosen by
// hash off a built board alone, so a row is as likely on the way on as in a dead
// end and reads no flame, sign or level. A row builds into no board.
export const ROW_PERCENT = 4;
export const ROW_COINS = 3;
export const ROW_PITCH = 7;

const rowCache = new WeakMap();

/**
 * The west cells of the corridors of board `bd` that hold a row, ascending: a
 * tree link east from the cell whose `row` hash passes ROW_PERCENT. A rock
 * board has none. The list is computed once per board object.
 */
export function coinRows(world, bd) {
  let rows = rowCache.get(bd);
  if (rows) return rows;
  rows = [];
  if (bd.links) {
    for (let cell = 0; cell < NCELL; cell++) {
      if (bd.links[cell] & 1 && u32(world.H('row', bd.x, bd.y, cell)) % 100 < ROW_PERCENT) rows.push(cell);
    }
  }
  rowCache.set(bd, rows);
  return rows;
}

/**
 * The floor point of coin `i` of the row east of `cell`, in world pixels: the
 * middle of the wall opening between the two rooms, ROW_PITCH px apart. Every
 * coin lies 17 px from both standing points of the corridor, past the reach.
 */
export function rowSpot(bd, cell, i) {
  return [
    bd.x * BOARD_PX_W + (cell % BW) * CELL_PX + CELL_PX + ROW_PITCH * (i - (ROW_COINS - 1) / 2),
    bd.y * BOARD_PX_H + ((cell / BW) | 0) * CELL_PX + 8,
  ];
}
