// Signs (spec section 4): a glyph carved at some junctions of a route board
// that points along the link toward the way on. Signs derive from a built
// board and the hash alone; they enter no board, band or digest.
import { NCELL, cellNeighbor } from './board.mjs';
import { BDX, BDY } from './band.mjs';
import { u32 } from './hash.mjs';

export const SIGN_MOD = 48;
// A sign junction carries a sign when its hash mod SIGN_MOD is under the
// level's threshold: about 1 in 6, 8, 12 and 16.
export const SIGN_THRESHOLD = { easy: 8, medium: 6, hard: 4, ultimate: 3 };

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

/** The sign junctions of `bd` whose hash passes the level's threshold. */
export function signs(world, bd) {
  const t = SIGN_THRESHOLD[world.difficulty];
  return junctions(world, bd).filter(({ cell }) => signHash(world, bd, cell) % SIGN_MOD < t);
}

/** The upper corner of the cell's room that carries its sign: 0 left, 1 right. */
export function signSide(world, bd, cell) {
  return signHash(world, bd, cell) >>> 31;
}
