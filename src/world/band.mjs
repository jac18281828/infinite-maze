// Band maze (spec section 3): a tomb's 6x4 boards form a tree of a trunk from
// its first entry to its exit board, tributaries joining every other entry,
// and dead-end branches at most two boards deep. Board index i = 6 * row + x.
import { sfc32, u32 } from './hash.mjs';

/** Tomb size per difficulty, in boards; `hard` is the original 6x4 world. */
export const DIFFICULTY = {
  easy: { w: 3, h: 2 },
  medium: { w: 4, h: 3 },
  hard: { w: 6, h: 4 },
};
export const DIFFICULTIES = Object.keys(DIFFICULTY);
export const MAX_DEPTH = 2;

/** The route's minimum length: half the tomb's boards. */
export function minRoute(size) {
  return (size.w * size.h) >> 1;
}

// Board directions match cell directions 0..3: E N W S.
export const BDX = [1, 0, -1, 0];
export const BDY = [0, 1, 0, -1];

export function boardNeighbor(i, d, size = DIFFICULTY.hard) {
  const x = (i % size.w) + BDX[d], y = ((i / size.w) | 0) + BDY[d];
  if (x < 0 || x >= size.w || y < 0 || y >= size.h) return -1;
  return y * size.w + x;
}

function dfsRoute(rng, entry, exit, size) {
  const seen = new Uint8Array(size.w * size.h);
  const stack = [entry];
  seen[entry] = 1;
  const open = [];
  while (stack[stack.length - 1] !== exit) {
    const top = stack[stack.length - 1];
    open.length = 0;
    for (let d = 0; d < 4; d++) {
      const n = boardNeighbor(top, d, size);
      if (n >= 0 && !seen[n]) open.push(n);
    }
    if (open.length === 0) { stack.pop(); continue; }
    const n = open[rng() % open.length];
    seen[n] = 1;
    stack.push(n);
  }
  return stack;
}

/**
 * Attaches dead ends: repeatedly picks, uniformly, a tree board at depth
 * below MAX_DEPTH with an unused neighbour and attaches one such neighbour.
 */
function attachDeadEnds(rng, depth, parent, size) {
  const cands = [], free = [];
  for (;;) {
    cands.length = 0;
    for (let i = 0; i < depth.length; i++) {
      if (depth[i] < 0 || depth[i] >= MAX_DEPTH) continue;
      for (let d = 0; d < 4; d++) {
        const n = boardNeighbor(i, d, size);
        if (n >= 0 && depth[n] < 0) { cands.push(i); break; }
      }
    }
    if (cands.length === 0) return;
    const i = cands[rng() % cands.length];
    free.length = 0;
    for (let d = 0; d < 4; d++) {
      const n = boardNeighbor(i, d, size);
      if (n >= 0 && depth[n] < 0) free.push(n);
    }
    const n = free[rng() % free.length];
    depth[n] = depth[i] + 1;
    parent[n] = i;
  }
}

/**
 * Randomized DFS from `from` over boards outside the tree (`inTree`), ending
 * on its first step onto a tree board. Returns the stack without that board
 * and the board joined. The unused component holding `from` touches the
 * tree, so the search always ends.
 */
function dfsJoin(rng, from, inTree) {
  const seen = new Uint8Array(NBOARD);
  const stack = [from];
  seen[from] = 1;
  const open = [];
  for (;;) {
    const top = stack[stack.length - 1];
    open.length = 0;
    for (let d = 0; d < 4; d++) {
      const n = boardNeighbor(top, d);
      if (n >= 0 && !seen[n]) open.push(n);
    }
    if (open.length === 0) { stack.pop(); continue; }
    const n = open[rng() % open.length];
    if (inTree[n]) return { stack, join: n };
    seen[n] = 1;
    stack.push(n);
  }
}

/**
 * The band tree of tomb (u, v). `walls` lists its wall doors, the exit
 * first, as `createFlow` gives them. The entries are the in-door boards in
 * wall order, or for a source tomb its single board S. The trunk runs from
 * the first entry to the exit board X; each later entry outside the tree
 * joins it by a tributary; dead ends hang off both.
 *
 * Per board i: `routeIndex[i]` is the index along its own route or -1,
 * `depth[i]` is 0 on a route, 1..2 on a dead end, -1 for rock, and
 * `next[i]` is the board the way on leads to: the route successor, a dead
 * end's parent, or -1 on X. `routeEntry[r]` is the wall a route enters by:
 * the in-door direction, or -1 for S. `dropTributary` leaves each tributary
 * unjoined, a broken world.
 */
export function buildTombTree(H, u, v, walls, { dropTributary = false } = {}) {
  const exit = walls[0].dir, X = walls[0].i;
  const ins = walls.slice(1);
  const source = ins.length === 0;
  const entries = source ? [u32(H('source', u, v)) % NBOARD] : ins.map((w) => w.i);
  for (let k = 0; ; k++) {
    const rng = sfc32(H('band', u, v, k));
    const trunk = dfsRoute(rng, entries[0], X);
    // A trunk of the one board X is exempt: no reroll lengthens it.
    if (trunk.length < MIN_ROUTE && entries[0] !== X) continue;
    const routeIndex = new Int8Array(NBOARD).fill(-1);
    const depth = new Int8Array(NBOARD).fill(-1);
    const next = new Int8Array(NBOARD).fill(-1);
    const routeOf = new Int8Array(NBOARD).fill(-1);
    const inTree = new Uint8Array(NBOARD);
    const routes = [trunk];
    const routeEntry = [source ? -1 : ins[0].dir];
    const lay = (route, r, last) => {
      route.forEach((i, j) => {
        routeIndex[i] = j; depth[i] = 0; inTree[i] = 1; routeOf[i] = r;
        next[i] = j + 1 < route.length ? route[j + 1] : last;
      });
    };
    lay(trunk, 0, -1);
    for (let j = 1; j < entries.length; j++) {
      if (inTree[entries[j]]) continue;
      const { stack, join } = dfsJoin(rng, entries[j], inTree);
      routes.push(stack);
      routeEntry.push(ins[j].dir);
      lay(stack, routes.length - 1, dropTributary ? -1 : join);
    }
    const parent = new Int8Array(NBOARD).fill(-1);
    attachDeadEnds(rng, depth, parent);
    for (let i = 0; i < NBOARD; i++) if (depth[i] > 0) next[i] = parent[i];
    return { u, v, k, exit, X, walls, source, entries, routes, routeEntry, routeOf, routeIndex, depth, next };
  }
}
