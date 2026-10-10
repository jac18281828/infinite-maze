// Band maze (spec section 3, docs/ROUTE.md section 4): a randomized DFS route
// through the 6x4 boards from the entry board to the exit board, then
// dead-end branches at most two boards deep. Board index i = 6 * row + x.
import { sfc32, u32 } from './hash.mjs';

export const BANDW = 6;
export const BANDH = 4;
export const NBOARD = BANDW * BANDH;
export const MIN_ROUTE = 12;
export const MAX_DEPTH = 2;

// Board directions match cell directions 0..3: E N W S.
export const BDX = [1, 0, -1, 0];
export const BDY = [0, 1, 0, -1];

// Route walls L R D U as board directions.
export const WALL_DIR = [2, 0, 3, 1];

export function boardNeighbor(i, d) {
  const x = (i % BANDW) + BDX[d], y = ((i / BANDW) | 0) + BDY[d];
  if (x < 0 || x >= BANDW || y < 0 || y >= BANDH) return -1;
  return y * BANDW + x;
}

/**
 * Index of the board of band (u, v) behind its crossing on wall w (L R D U).
 * Both bands on a wall read the same key: `bandv` for a side wall, `bandh`
 * for a floor or ceiling.
 */
export function wallBoard(H, u, v, w) {
  switch (w) {
    case 0: return (u32(H('bandv', u - 1, v)) % BANDH) * BANDW;
    case 1: return (u32(H('bandv', u, v)) % BANDH) * BANDW + BANDW - 1;
    case 2: return u32(H('bandh', u, v - 1)) % BANDW;
    default: return (BANDH - 1) * BANDW + u32(H('bandh', u, v)) % BANDW;
  }
}

function dfsRoute(rng, entry, exit) {
  const seen = new Uint8Array(NBOARD);
  const stack = [entry];
  seen[entry] = 1;
  const open = [];
  while (stack[stack.length - 1] !== exit) {
    const top = stack[stack.length - 1];
    open.length = 0;
    for (let d = 0; d < 4; d++) {
      const n = boardNeighbor(top, d);
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
function attachDeadEnds(rng, depth, parent) {
  const cands = [], free = [];
  for (;;) {
    cands.length = 0;
    for (let i = 0; i < NBOARD; i++) {
      if (depth[i] < 0 || depth[i] >= MAX_DEPTH) continue;
      for (let d = 0; d < 4; d++) {
        const n = boardNeighbor(i, d);
        if (n >= 0 && depth[n] < 0) { cands.push(i); break; }
      }
    }
    if (cands.length === 0) return;
    const i = cands[rng() % cands.length];
    free.length = 0;
    for (let d = 0; d < 4; d++) {
      const n = boardNeighbor(i, d);
      if (n >= 0 && depth[n] < 0) free.push(n);
    }
    const n = free[rng() % free.length];
    depth[n] = depth[i] + 1;
    parent[n] = i;
  }
}

/**
 * The band tree of route band (u, v), entered through wall E and left
 * through wall X (L R D U). `routeIndex[i]` is the route position or -1;
 * `depth[i]` is 0 on the route, 1..2 on a dead end, -1 for rock;
 * `parent[i]` is the board a dead end hangs from, else -1. A corner board
 * holding both the entry and the exit is the whole route, exempt from
 * MIN_ROUTE.
 */
export function buildBandTree(H, u, v, E, X) {
  const entry = wallBoard(H, u, v, E), exit = wallBoard(H, u, v, X);
  for (let k = 0; ; k++) {
    const rng = sfc32(H('band', u, v, k));
    const route = dfsRoute(rng, entry, exit);
    if (route.length < MIN_ROUTE && entry !== exit) continue;
    const routeIndex = new Int8Array(NBOARD).fill(-1);
    const depth = new Int8Array(NBOARD).fill(-1);
    const parent = new Int8Array(NBOARD).fill(-1);
    route.forEach((i, r) => { routeIndex[i] = r; depth[i] = 0; });
    attachDeadEnds(rng, depth, parent);
    return { u, v, rock: false, k, entryWall: E, exitWall: X, entry, exit, route, routeIndex, depth, parent };
  }
}

/** A band off the route: every board is rock. */
export function rockBand(u, v) {
  const none = new Int8Array(NBOARD).fill(-1);
  return {
    u, v, rock: true, k: -1, entryWall: -1, exitWall: -1, entry: -1, exit: -1,
    route: [], routeIndex: none, depth: none, parent: none,
  };
}
