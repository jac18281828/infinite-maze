// Board cell maze: a growing-tree spanning tree over the 12x7 cell grid,
// rerolled until the primary path meets the spec section 4 targets.
import { sfc32 } from './hash.mjs';

export const BW = 12;
export const BH = 7;
export const NCELL = BW * BH;
export const MAX_REROLL = 64;

// Directions with y up: E N W S NE NW SW SE. The opposite of d is d ^ 2.
export const DX = [1, 0, -1, 0, 1, -1, -1, 1];
export const DY = [0, 1, 0, -1, 1, 1, -1, -1];
const WEIGHT = [4, 1, 4, 1, 1, 1, 1, 1];

// Walking time per link in ms at spec speeds over 48 px cells:
// run 48/96 s, ladder 48/48 s, gallery 48*sqrt(2)/72 s rounded to 943 ms.
export const COST = [500, 1000, 500, 1000, 943, 943, 943, 943];

export const TARGET_PATH = 22;
export const TARGET_JUNCTIONS = 6;
export const TARGET_BRANCH = 3;

// NB[8c + d] is the cell beside c in direction d, or -1 off the grid.
const NB = new Int16Array(NCELL * 8);
// XC[8c + d] for a diagonal d: the crossing link as (cell << 3) | dir.
const XC = new Int16Array(NCELL * 8);
for (let c = 0; c < NCELL; c++) {
  const x = c % BW, y = (c / BW) | 0;
  for (let d = 0; d < 8; d++) {
    const nx = x + DX[d], ny = y + DY[d];
    NB[8 * c + d] = nx < 0 || nx >= BW || ny < 0 || ny >= BH ? -1 : ny * BW + nx;
  }
  XC[8 * c + 4] = ((c + 1) << 3) | 5;        // NE crosses (x+1,y) NW
  XC[8 * c + 5] = ((c - 1) << 3) | 4;        // NW crosses (x-1,y) NE
  XC[8 * c + 6] = ((c - BW) << 3) | 5;       // SW crosses (x,y-1) NW
  XC[8 * c + 7] = ((c - BW) << 3) | 4;       // SE crosses (x,y-1) NE
}

export function cellNeighbor(c, d) {
  return NB[8 * c + d];
}

const seen = new Uint8Array(NCELL);
const active = new Int16Array(NCELL);
const cand = new Int32Array(8);

/** Carves a spanning tree into `links` (bit d set = link in direction d). */
export function growTree(rng, links) {
  links.fill(0);
  seen.fill(0);
  let len = 0;
  const start = rng() % NCELL;
  seen[start] = 1;
  active[len++] = start;
  while (len) {
    const i = rng() % 5 < 3 ? len - 1 : rng() % len;
    const c = active[i];
    let n = 0, total = 0;
    for (let d = 0; d < 8; d++) {
      const t = NB[8 * c + d];
      if (t < 0 || seen[t]) continue;
      if (d >= 4) {
        const x = XC[8 * c + d];
        if (links[x >> 3] & (1 << (x & 7))) continue;
      }
      cand[n++] = d;
      total += WEIGHT[d];
    }
    if (n === 0) {
      // Removal keeps age order, so the last entry stays the newest cell.
      active.copyWithin(i, i + 1, len);
      len--;
      continue;
    }
    let r = rng() % total;
    let d = cand[0];
    for (let j = 0; j < n; j++) {
      r -= WEIGHT[cand[j]];
      if (r < 0) { d = cand[j]; break; }
    }
    const t = NB[8 * c + d];
    links[c] |= 1 << d;
    links[t] |= 1 << (d ^ 2);
    seen[t] = 1;
    active[len++] = t;
  }
  return links;
}

const dist = new Int16Array(NCELL);
const parent = new Int16Array(NCELL);
const order = new Int16Array(NCELL);
const onPath = new Uint8Array(NCELL);
const subMax = new Int16Array(NCELL);
const subDoor = new Uint8Array(NCELL);

/**
 * Measures a tree against the targets. `a` is the first primary cell; `b` is
 * the second, or -1 for the deepest cell from `a` (ties to the lowest index).
 * Branches holding a cell flagged in `isDoor` are exempt from the length rule.
 */
export function analyze(links, a, b, isDoor) {
  dist.fill(-1);
  parent.fill(-1);
  onPath.fill(0);
  let head = 0, tail = 0;
  dist[a] = 0;
  order[tail++] = a;
  while (head < tail) {
    const c = order[head++];
    const m = links[c];
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const t = NB[8 * c + d];
      if (dist[t] >= 0) continue;
      dist[t] = dist[c] + 1;
      parent[t] = c;
      order[tail++] = t;
    }
  }
  if (b < 0) {
    b = a;
    for (let c = 0; c < NCELL; c++) if (dist[c] > dist[b]) b = c;
  }
  let pathLen = 0;
  for (let c = b; c >= 0; c = parent[c]) { onPath[c] = 1; pathLen++; }
  for (let c = 0; c < NCELL; c++) { subMax[c] = dist[c]; subDoor[c] = isDoor[c]; }
  for (let i = tail - 1; i > 0; i--) {
    const c = order[i], p = parent[c];
    if (subMax[c] > subMax[p]) subMax[p] = subMax[c];
    subDoor[p] |= subDoor[c];
  }
  let junctions = 0, shortfall = 0, shortBranches = 0;
  for (let j = b; j >= 0; j = parent[j]) {
    let branches = 0;
    const m = links[j];
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const t = NB[8 * j + d];
      if (onPath[t]) continue;
      branches++;
      const depth = subMax[t] - dist[j];
      if (!subDoor[t] && depth < TARGET_BRANCH) {
        shortBranches++;
        shortfall += TARGET_BRANCH - depth;
      }
    }
    if (branches) junctions++;
  }
  const deficit = Math.max(0, TARGET_PATH - pathLen)
    + Math.max(0, TARGET_JUNCTIONS - junctions) + shortfall;
  return { a, b, pathLen, junctions, shortBranches, deficit };
}

/**
 * Builds the cell maze of board (x, y). `doorCells` lists every door cell;
 * the primary pair is (a, b), with b = -1 on a dead-end board. Attempts run
 * k = 0..64; the first to meet every target wins, else the lowest deficit
 * (earliest k on ties) is kept as the best-attempt fallback.
 */
export function buildBoardMaze(H, x, y, doorCells, a, b) {
  const isDoor = new Uint8Array(NCELL);
  for (const c of doorCells) isDoor[c] = 1;
  const links = new Uint8Array(NCELL);
  let best = null, bestLinks = null;
  for (let k = 0; k <= MAX_REROLL; k++) {
    growTree(sfc32(H('board', x, y, k)), links);
    const r = analyze(links, a, b, isDoor);
    if (r.deficit === 0) {
      return { links, k, fallback: false, ...r };
    }
    if (!best || r.deficit < best.deficit) {
      best = { k, ...r };
      bestLinks = links.slice();
    }
  }
  return { links: bestLinks, fallback: true, ...best };
}
