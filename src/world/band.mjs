// Band maze (spec section 3): a randomized DFS route through the tomb's W x H
// boards, then dead-end branches at most two boards deep. Board index
// i = W * row + x.
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

/** Column e_b of the door between bands b-1 and b. */
export function edgeColumn(H, b, size = DIFFICULTY.hard) {
  return u32(H('edge', b)) % size.w;
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
 * The band tree of band b in a tomb of `size` boards. `routeIndex[i]` is the
 * route position or -1; `depth[i]` is 0 on the route, 1..2 on a dead end, -1
 * for rock; `parent[i]` is the board a dead end hangs from, else -1.
 */
export function buildBandTree(H, b, size = DIFFICULTY.hard) {
  const n = size.w * size.h, min = minRoute(size);
  const entryX = edgeColumn(H, b, size);
  const exitX = edgeColumn(H, b + 1, size);
  const entry = entryX, exit = (size.h - 1) * size.w + exitX;
  for (let k = 0; ; k++) {
    const rng = sfc32(H('band', b, k));
    const route = dfsRoute(rng, entry, exit, size);
    if (route.length < min) continue;
    const routeIndex = new Int8Array(n).fill(-1);
    const depth = new Int8Array(n).fill(-1);
    const parent = new Int8Array(n).fill(-1);
    route.forEach((i, r) => { routeIndex[i] = r; depth[i] = 0; });
    attachDeadEnds(rng, depth, parent, size);
    return { b, k, entryX, exitX, route, routeIndex, depth, parent };
  }
}
