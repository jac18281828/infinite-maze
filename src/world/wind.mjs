// Wind (spec section 4): some dead-end branches of a route board are windy,
// and the dust drifts toward such a branch's entrance. Wind derives from built
// boards and the hash alone; it enters no board, band or digest.
import { NCELL } from './board.mjs';
import { BDX, BDY } from './band.mjs';
import { u32 } from './hash.mjs';
import { wayOn } from './signs.mjs';

export const WIND_MOD = 64;
// A branch of n carved cells is windy when its hash mod WIND_MOD is under
// min(n, WIND_CAP): the chance grows with length to 18/64 at 18 cells.
export const WIND_CAP = 18;

const cache = new WeakMap();

/** The route board whose way on `bd`'s branch hangs from, or null for a rock board. */
function routeOf(world, bd) {
  let b = bd;
  while (b.kind === 'dead') b = world.board(b.x + BDX[b.aDir], b.y + BDY[b.aDir]);
  return b.kind === 'route' ? b : null;
}

/**
 * Branches of route board `bd` and, per board p, the direction toward the
 * junction at each cell of its windy branches, -1 elsewhere. A branch is
 * what hangs off the way on through one link or door: the cell beyond it and
 * every carved cell reachable from there without entering the way on.
 */
function build(world, bd) {
  const { on } = wayOn(world, bd);
  const flames = new Set(world.flamesAt(bd.x, bd.y));
  const isWay = (b, c) => (b === bd ? on.has(c) : b.kind === 'route' && wayOn(world, b).on.has(c));
  const seen = new Map();
  const wind = new Map();
  const mark = (b) => {
    let s = seen.get(b.p);
    if (!s) { s = new Uint8Array(NCELL); seen.set(b.p, s); }
    return s;
  };
  const branches = [];
  for (const junction of [...on].sort((p, q) => p - q)) {
    for (let dir = 0; dir < 8; dir++) {
      const first = world.step(bd, junction, dir);
      if (!first || isWay(first.board, first.cell)) continue;
      // Each queued cell holds the direction back toward the junction.
      const queue = [{ board: first.board, cell: first.cell, back: dir ^ 2 }];
      mark(first.board)[first.cell] = 1;
      let flame = false;
      for (let h = 0; h < queue.length; h++) {
        const q = queue[h];
        if (q.board === bd && flames.has(q.cell)) flame = true;
        for (let e = 0; e < 8; e++) {
          const s = world.step(q.board, q.cell, e);
          if (!s || isWay(s.board, s.cell)) continue;
          const m = mark(s.board);
          if (m[s.cell]) continue;
          m[s.cell] = 1;
          queue.push({ board: s.board, cell: s.cell, back: e ^ 2 });
        }
      }
      const { x, y } = first.board;
      const n = queue.length;
      const windy = !flame && u32(world.H('wind', x, y, first.cell)) % WIND_MOD < Math.min(n, WIND_CAP);
      if (windy) {
        for (const q of queue) {
          let w = wind.get(q.board.p);
          if (!w) { w = new Int8Array(NCELL).fill(-1); wind.set(q.board.p, w); }
          w[q.cell] = q.back;
        }
      }
      branches.push({ junction, dir, x, y, cell: first.cell, n, windy });
    }
  }
  return { branches, wind };
}

function info(world, bd) {
  let r = cache.get(bd);
  if (!r) { r = build(world, bd); cache.set(bd, r); }
  return r;
}

/**
 * The dead-end branches of route board `bd` as { junction, dir, x, y, cell,
 * n, windy }, ascending by junction, then dir: `junction` is the way-on cell,
 * `dir` the link or door from it into the branch, (x, y, cell) the branch's
 * first cell, `n` its carved cells across every board it spans and `windy`
 * the rule's verdict. A dead-end or rock board has none.
 */
export function windBranches(world, bd) {
  return bd.kind === 'route' ? info(world, bd).branches : [];
}

/**
 * The link or door, 0..7, that leads from `cell` of board `bd` toward the
 * junction of its windy branch, else -1: on the way on, in a windless branch
 * and on a rock board. A dead-end board belongs to the branch its route
 * board lists.
 */
export function windDir(world, bd, cell) {
  const route = routeOf(world, bd);
  if (!route) return -1;
  const w = info(world, route).wind.get(bd.p);
  return w ? w[cell] : -1;
}
