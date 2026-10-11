// Pointers (spec section 4): at some junctions of a route board, an arrow
// carved in the wall or a skeleton slumped in a corner, each pointing along
// the link toward the way on. They derive from a built board and the hash
// alone; they enter no board, band or digest. The module keeps its name
// because wind imports `wayOn`.
import { BW, NCELL, cellNeighbor } from './board.mjs';
import { BDX, BDY } from './band.mjs';
import { u32 } from './hash.mjs';

export const SIGN_MOD = 1024;
// One hash mod SIGN_MOD gives a junction at most one pointer, by band:
// [0, t) a tier-1 skeleton, [t, 2t) a tier-2 skeleton and [2t, 2t + a) an
// arrow. Each tier holds about one skeleton per tomb. The arrow band is
// round(SIGN_MOD / N): arrows at 1 junction in N = 12, 16, 24 and 32.
export const SKELETON_THRESHOLD = { easy: 94, medium: 30, hard: 17, ultimate: 11 };
export const ARROW_THRESHOLD = { easy: 85, medium: 64, hard: 43, ultimate: 32 };

const ways = (m) => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};

/**
 * The way on of route board `bd`: `o`, the out-door's cell; `toward[c]`, the
 * link direction from cell c to the next cell of its path to `o`, -1 where
 * none; and `on`, every cell on the tree path from an in-cell to `o`, `o`
 * included. The in-cells are where routes enter: the cell of each door whose
 * far board is a route board leading back through it, and the flame cell of a
 * source board. A board that is not a route board has none.
 */
export function wayOn(world, bd) {
  if (bd.kind !== 'route') return null;
  const o = bd.doors.find((d) => d.dir === bd.bDir).cell;
  const toward = new Int8Array(NCELL).fill(-1);
  const seen = new Uint8Array(NCELL);
  const queue = [o];
  seen[o] = 1;
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    for (let d = 0; d < 8; d++) {
      if (!(bd.links[c] & (1 << d))) continue;
      const n = cellNeighbor(c, d);
      if (seen[n]) continue;
      seen[n] = 1;
      toward[n] = d ^ 2;
      queue.push(n);
    }
  }
  const ins = [];
  if (bd.aDir < 0) ins.push(bd.a);
  for (const door of bd.doors) {
    const far = world.board(bd.x + BDX[door.dir], bd.y + BDY[door.dir]);
    if (far.kind === 'route' && far.bDir === (door.dir ^ 2)) ins.push(door.cell);
  }
  const on = new Set();
  for (let c of ins) {
    while (c !== o && toward[c] >= 0 && !on.has(c)) {
      on.add(c);
      c = cellNeighbor(c, toward[c]);
    }
  }
  on.add(o);
  return { o, toward, on };
}

/**
 * The sign junctions of route board `bd` as { cell, dir }, ascending by
 * cell. A sign junction lies on the way on, `o` excepted, with three or more
 * real ways out: its links plus its doors, less its links into a stub. A stub
 * is a door-free cell with one link, a source board's flame cell excepted: the
 * player arrives from that cell, so a link into it is a way. `dir` is the link
 * from the cell toward `o`. A board that is not a route board has none.
 */
export function junctions(world, bd) {
  const way = wayOn(world, bd);
  if (!way) return [];
  const { o, toward, on } = way;
  const stub = (c) => ways(bd.links[c]) === 1 && !bd.doorMask[c] && !(bd.aDir < 0 && c === bd.a);
  const choices = (c) => {
    let n = ways(bd.links[c]) + ways(bd.doorMask[c]);
    for (let d = 0; d < 8; d++) if (bd.links[c] & (1 << d) && stub(cellNeighbor(c, d))) n--;
    return n;
  };
  return [...on]
    .filter((c) => c !== o && choices(c) >= 3)
    .sort((p, q) => p - q)
    .map((cell) => ({ cell, dir: toward[cell] }));
}

const signHash = (world, bd, cell) => u32(world.H('sign', bd.x, bd.y, cell));

/** Whether cells p and q of one board lie within Chebyshev distance 1. */
const adjacent = (p, q) =>
  Math.max(Math.abs((p % BW) - (q % BW)), Math.abs(((p / BW) | 0) - ((q / BW) | 0))) <= 1;

/**
 * The pointers of `bd` left standing, as { skeletons, boostSkeletons, arrows }.
 * Each is a band of the junctions by hash mod SIGN_MOD, ascending by cell. No
 * two pointers of a board stand within one cell: tier 1 goes first, then the
 * arrows, then tier 2, so a tier-2 skeleton, hidden above half the burn, never
 * removes a pointer the player can see. A candidate stands unless a pointer
 * already standing lies within distance 1.
 */
function standing(world, bd) {
  const t = SKELETON_THRESHOLD[world.difficulty];
  const bands = [[0, t], [2 * t, 2 * t + ARROW_THRESHOLD[world.difficulty]], [t, 2 * t]];
  const cands = junctions(world, bd).map((j) => ({ ...j, h: signHash(world, bd, j.cell) % SIGN_MOD }));
  const kept = [];
  const [tier1, arrow, tier2] = bands.map(([lo, hi]) => {
    const out = [];
    for (const { cell, dir, h } of cands) {
      if (h < lo || h >= hi || kept.some((c) => adjacent(c, cell))) continue;
      kept.push(cell);
      out.push({ cell, dir });
    }
    return out;
  });
  return { skeletons: tier1, boostSkeletons: tier2, arrows: arrow };
}

/** Tier 1, shown at every burn: the junctions whose hash lies in [0, t). */
export function skeletons(world, bd) {
  return standing(world, bd).skeletons;
}

/** Tier 2, shown under half the burn: the junctions whose hash lies in [t, 2t). */
export function boostSkeletons(world, bd) {
  return standing(world, bd).boostSkeletons;
}

/** The junctions whose hash lies in [2t, 2t + a). */
export function arrows(world, bd) {
  return standing(world, bd).arrows;
}

/** The upper corner of the cell's room that carries its arrow: 0 left, 1 right. */
export function arrowSide(world, bd, cell) {
  return signHash(world, bd, cell) >>> 31;
}

// Link bits of a gallery that runs toward the right (NE, SE) and the left (NW, SW).
const GALLERY_RIGHT = (1 << 4) | (1 << 7);
const GALLERY_LEFT = (1 << 5) | (1 << 6);

/**
 * The lower corner of the cell's room that holds its skeleton: 0 left, 1
 * right. A way on to the right prefers the left corner and one to the left the
 * right, so the arm reaches across the room; an up or down way takes the
 * hash's corner, bit 31. A corner under the cell's gallery gives way to the
 * other.
 */
export function skeletonSide(world, bd, cell, dir) {
  const side = dir === 0 ? 0 : dir === 2 ? 1 : signHash(world, bd, cell) >>> 31;
  const blocked = bd.links[cell] & (side ? GALLERY_RIGHT : GALLERY_LEFT);
  return blocked ? side ^ 1 : side;
}
