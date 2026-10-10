// Board cell maze: a growing-tree spanning tree over the 12x7 cell grid. Each
// attempt repairs the tree by edge swaps, and attempts reroll until the
// primary path meets the spec section 4 targets. The chosen tree is then
// carved down to CARVE_CELLS cells; the rest is rock. Each gallery owns a 2x2
// block that holds no other link, and blocks never overlap, so a cell has at
// most one gallery.
import { sfc32, u32 } from './hash.mjs';

export const BW = 12;
export const BH = 7;
export const NCELL = BW * BH;
export const MAX_REROLL = 32;
// Each attempt makes at most MAX_SWAPS edge swaps.
export const MAX_SWAPS = 24;
// Each attempt keeps up to MAX_BLOCKS gallery blocks from BLOCK_DRAWS draws.
export const MAX_BLOCKS = 8;
export const BLOCK_DRAWS = 32;
// The carve keeps this many cells of a board's tree, or more when no cut
// qualifies.
export const CARVE_CELLS = 50;

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
// GRID[c]: the orthogonal directions that stay on the grid.
const GRID = new Uint8Array(NCELL);
for (let c = 0; c < NCELL; c++) {
  const x = c % BW, y = (c / BW) | 0;
  for (let d = 0; d < 8; d++) {
    const nx = x + DX[d], ny = y + DY[d];
    NB[8 * c + d] = nx < 0 || nx >= BW || ny < 0 || ny >= BH ? -1 : ny * BW + nx;
    if (d < 4 && NB[8 * c + d] >= 0) GRID[c] |= 1 << d;
  }
}

export function cellNeighbor(c, d) {
  return NB[8 * c + d];
}

const seen = new Uint8Array(NCELL);
const active = new Int16Array(NCELL);
const cand = new Int32Array(8);
// open[c]: directions growTree may carve from c.
const open = new Uint8Array(NCELL);
const owned = new Uint8Array(NCELL);
const saved = new Uint8Array(4);
// Corners of the block at its lower-left cell a: a, a+1, a+BW, a+BW+1.
const CORNER = [0, 1, BW, BW + 1];
// In-block orthogonal links of each corner: E N, N W, E S, W S.
const IN_BLOCK = [0b0011, 0b0110, 0b1001, 0b1100];

/**
 * True when the `open` graph joins the four corners of the block at a. The
 * graph was connected before the block changed it, and every path to a
 * changed link meets a corner first, so joined corners keep it connected.
 */
function cornersJoined(a) {
  seen.fill(0);
  seen[a] = 1;
  active[0] = a;
  let tail = 1, found = 1;
  for (let h = 0; h < tail; h++) {
    const c = active[h], m = open[c];
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d))) continue;
      const t = NB[8 * c + d];
      if (seen[t]) continue;
      seen[t] = 1;
      active[tail++] = t;
      if ((t === a + 1 || t === a + BW || t === a + BW + 1) && ++found === 4) return true;
    }
  }
  return false;
}

/**
 * Opens the orthogonal grid, then reserves disjoint 2x2 blocks: draws stop
 * at MAX_BLOCKS kept or BLOCK_DRAWS made. A block overlapping a kept one is
 * skipped. A kept block loses its in-block orthogonal links and offers one
 * diagonal; a block that would disconnect the open graph is dropped.
 */
function reserveBlocks(rng) {
  open.set(GRID);
  owned.fill(0);
  for (let k = 0, kept = 0; k < BLOCK_DRAWS && kept < MAX_BLOCKS; k++) {
    const a = (rng() % (BH - 1)) * BW + rng() % (BW - 1);
    const ne = rng() % 2 === 0;
    if (owned[a] | owned[a + 1] | owned[a + BW] | owned[a + BW + 1]) continue;
    for (let j = 0; j < 4; j++) {
      saved[j] = open[a + CORNER[j]];
      open[a + CORNER[j]] &= ~IN_BLOCK[j];
    }
    if (ne) { open[a] |= 1 << 4; open[a + BW + 1] |= 1 << 6; }
    else { open[a + 1] |= 1 << 5; open[a + BW] |= 1 << 7; }
    if (cornersJoined(a)) {
      for (let j = 0; j < 4; j++) owned[a + CORNER[j]] = 1;
      kept++;
    } else {
      for (let j = 0; j < 4; j++) open[a + CORNER[j]] = saved[j];
    }
  }
}

/**
 * Carves a spanning tree into `links` (bit d set = link in direction d). The
 * open graph stays connected, so the tree spans every cell.
 */
export function growTree(rng, links) {
  reserveBlocks(rng);
  links.fill(0);
  seen.fill(0);
  let len = 0;
  const start = rng() % NCELL;
  seen[start] = 1;
  active[len++] = start;
  while (len) {
    const i = rng() % 5 < 3 ? len - 1 : rng() % len;
    const c = active[i];
    const m = open[c];
    let n = 0, total = 0;
    for (let d = 0; d < 8; d++) {
      if (!(m & (1 << d)) || seen[NB[8 * c + d]]) continue;
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

// Figures of the last `measure`.
const fig = { b: 0, pathLen: 0, junctions: 0, shortBranches: 0, deficit: 0 };

/**
 * Measures a tree against the targets into `fig`. `a` is the first primary
 * cell; `b` is the second, or -1 for the deepest cell from `a` (ties to the
 * lowest index). Branches holding a cell flagged in `isDoor` are exempt from
 * the length rule. Returns the deficit.
 */
function measure(links, a, b, isDoor) {
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
  fig.b = b;
  fig.pathLen = pathLen;
  fig.junctions = junctions;
  fig.shortBranches = shortBranches;
  return fig.deficit = deficit;
}

/** The figures of the last `measure`, with the primary pair (a, b) resolved. */
function figures(a) {
  const { b, pathLen, junctions, shortBranches, deficit } = fig;
  return { a, b, pathLen, junctions, shortBranches, deficit };
}

export function analyze(links, a, b, isDoor) {
  measure(links, a, b, isDoor);
  return figures(a);
}

const baseParent = new Int16Array(NCELL);
const baseDist = new Int16Array(NCELL);
const inShort = new Uint8Array(NCELL);
const upCell = new Int16Array(NCELL);
const upDir = new Uint8Array(NCELL);
const cycCell = new Int16Array(2 * NCELL);
const cycDir = new Uint8Array(2 * NCELL);

/**
 * Flags in `inShort` every cell of a short branch, and snapshots the tree
 * shape of the last `measure` into `baseParent` and `baseDist`. Branches
 * come off the primary path, so the BFS order meets a parent first.
 */
function markShort() {
  baseParent.set(parent);
  baseDist.set(dist);
  inShort.fill(0);
  for (let i = 1; i < NCELL; i++) {
    const c = order[i];
    if (onPath[c]) continue;
    const p = parent[c];
    inShort[c] = onPath[p]
      ? (!subDoor[c] && subMax[c] - dist[p] < TARGET_BRANCH ? 1 : 0)
      : inShort[p];
  }
}

/** Direction from cell c to its neighbour t, or -1 when they are not adjacent. */
function dirTo(c, t) {
  for (let d = 0; d < 8; d++) if (NB[8 * c + d] === t) return d;
  return -1;
}

/**
 * Lists the tree links on the cycle that the link u-v would close, into
 * cycCell and cycDir (a cell and the direction of its link), u's side
 * first. Returns the count.
 */
function cycleLinks(u, v) {
  let n = 0, nu = 0;
  while (u !== v) {
    if (baseDist[u] >= baseDist[v]) {
      upCell[nu] = u; upDir[nu++] = dirTo(u, baseParent[u]);
      u = baseParent[u];
    } else {
      cycCell[NCELL + n] = v; cycDir[NCELL + n++] = dirTo(v, baseParent[v]);
      v = baseParent[v];
    }
  }
  for (let i = 0; i < nu; i++) { cycCell[i] = upCell[i]; cycDir[i] = upDir[i]; }
  for (let i = 0; i < n; i++) { cycCell[nu + i] = cycCell[NCELL + i]; cycDir[nu + i] = cycDir[NCELL + i]; }
  return nu + n;
}

function addLink(links, c, d) {
  links[c] |= 1 << d;
  links[NB[8 * c + d]] |= 1 << (d ^ 2);
}

function dropLink(links, c, d) {
  links[c] &= ~(1 << d);
  links[NB[8 * c + d]] &= ~(1 << (d ^ 2));
}

/**
 * Repairs a tree by edge swaps. A swap adds a link (u, v) from the `open`
 * graph that the last `growTree` left, and drops a link on the cycle it
 * closes, so the tree keeps spanning and every gallery keeps its block. The
 * source u runs over the cells of short branches in cell order, or over every
 * cell once no short branch is left; the first swap that lowers the deficit
 * stays. The repair stops at deficit 0, when no swap lowers it or after
 * MAX_SWAPS swaps. Returns the analysis of the repaired tree.
 */
export function repairTree(links, a, b, isDoor) {
  let deficit = measure(links, a, b, isDoor);
  let fresh = true;
  for (let swaps = 0; swaps < MAX_SWAPS && deficit > 0; swaps++) {
    markShort();
    const anyCell = fig.shortBranches === 0;
    let lowered = false;
    for (let u = 0; u < NCELL && !lowered; u++) {
      if (!anyCell && !inShort[u]) continue;
      for (let d = 0; d < 8 && !lowered; d++) {
        if (!(open[u] & (1 << d)) || links[u] & (1 << d)) continue;
        const v = NB[8 * u + d];
        const n = cycleLinks(u, v);
        addLink(links, u, d);
        for (let i = 0; i < n; i++) {
          dropLink(links, cycCell[i], cycDir[i]);
          const t = measure(links, a, b, isDoor);
          if (t < deficit) { deficit = t; lowered = true; break; }
          addLink(links, cycCell[i], cycDir[i]);
        }
        if (!lowered) dropLink(links, u, d);
      }
    }
    if (!lowered) { fresh = false; break; }
  }
  // A failed trial leaves `fig` on a trial tree.
  return fresh ? figures(a) : analyze(links, a, b, isDoor);
}

/** The board's flame cell: bytes 4-7 of H("flame", x, y) mod the cell count. */
export function flameCell(H, x, y) {
  return u32(H('flame', x, y), 4) % NCELL;
}

const pre = new Int16Array(NCELL);
const tin = new Int16Array(NCELL);
const size = new Int16Array(NCELL);
const protIn = new Uint8Array(NCELL);
const galIn = new Uint8Array(NCELL);
const doorIn = new Uint8Array(NCELL);
const deepIn = new Int16Array(NCELL);
const rootOf = new Int16Array(NCELL);
const gallery = new Uint8Array(NCELL);
const branches = new Uint8Array(NCELL);
const poolAll = new Int16Array(NCELL);
const poolFree = new Int16Array(NCELL);
const stack = new Int16Array(NCELL);

/**
 * Prunes the tree at `links`, rooted at a, down to `target` cells by cuts.
 * A cut at c removes c and every cell beyond it away from a. It qualifies
 * when it removes no `protect`ed cell, at most cells - target cells, and
 * leaves a deficit (with primary pair a, b) of at most `limit`. Each step
 * draws one qualifying cut at random, preferring cuts that remove no gallery
 * link, and stops at `target` cells or when no cut qualifies. A cut never
 * touches the a-b path, so a cut changes only the branch it lies in.
 */
function carve(links, a, b, isDoor, protect, target, limit, rng) {
  for (;;) {
    // Depth-first preorder, so every subtree is a contiguous range of `pre`.
    dist.fill(-1);
    let n = 0, top = 0;
    dist[a] = 0;
    parent[a] = -1;
    gallery[a] = 0;
    stack[top++] = a;
    while (top) {
      const c = stack[--top];
      tin[c] = n;
      pre[n++] = c;
      const m = links[c];
      for (let d = 7; d >= 0; d--) {
        if (!(m & (1 << d))) continue;
        const t = NB[8 * c + d];
        if (dist[t] >= 0) continue;
        dist[t] = dist[c] + 1;
        parent[t] = c;
        gallery[t] = d >= 4 ? 1 : 0;
        stack[top++] = t;
      }
    }
    const cells = n;
    if (cells <= target) return;
    onPath.fill(0);
    branches.fill(0);
    for (let i = 0; i < n; i++) {
      const c = pre[i];
      size[c] = 1; protIn[c] = protect[c]; galIn[c] = gallery[c];
      doorIn[c] = isDoor[c]; deepIn[c] = dist[c];
    }
    for (let i = n - 1; i > 0; i--) {
      const c = pre[i], p = parent[c];
      size[p] += size[c]; protIn[p] += protIn[c]; galIn[p] += galIn[c];
      doorIn[p] |= doorIn[c];
      if (deepIn[c] > deepIn[p]) deepIn[p] = deepIn[c];
    }
    for (let c = b; c >= 0; c = parent[c]) onPath[c] = 1;
    const pathLen = dist[b] + 1;
    // Branch roots hang off the path; rootOf maps a branch cell to its root.
    let junctions = 0, shortfall = 0;
    for (let i = 1; i < n; i++) {
      const c = pre[i], p = parent[c];
      if (onPath[c]) continue;
      if (onPath[p]) {
        rootOf[c] = c;
        if (!branches[p]++) junctions++;
        if (!doorIn[c]) shortfall += Math.max(0, TARGET_BRANCH - (deepIn[c] - dist[p]));
      } else rootOf[c] = rootOf[p];
    }
    const base = Math.max(0, TARGET_PATH - pathLen) + shortfall;
    const room = cells - target;
    let nAll = 0, nFree = 0;
    for (let c = 0; c < NCELL; c++) {
      if (dist[c] <= 0 || protIn[c] || size[c] > room) continue;
      const t = rootOf[c], j = parent[t];
      let deficit;
      if (c === t) {
        const js = junctions - (branches[j] === 1 ? 1 : 0);
        deficit = base - (doorIn[t] ? 0 : Math.max(0, TARGET_BRANCH - (deepIn[t] - dist[j])))
          + Math.max(0, TARGET_JUNCTIONS - js);
      } else {
        let deep = dist[t];
        const lo = tin[c], hi = lo + size[c];
        for (let i = tin[t], end = i + size[t]; i < end; i++) {
          if (i === lo) { i = hi - 1; continue; }
          if (dist[pre[i]] > deep) deep = dist[pre[i]];
        }
        deficit = base - (doorIn[t] ? 0 : Math.max(0, TARGET_BRANCH - (deepIn[t] - dist[j])))
          + (doorIn[t] ? 0 : Math.max(0, TARGET_BRANCH - (deep - dist[j])))
          + Math.max(0, TARGET_JUNCTIONS - junctions);
      }
      if (deficit > limit) continue;
      poolAll[nAll++] = c;
      if (!galIn[c]) poolFree[nFree++] = c;
    }
    const pool = nFree ? poolFree : poolAll, count = nFree || nAll;
    if (!count) return;
    const c = pool[rng() % count];
    for (let i = tin[c], end = i + size[c]; i < end; i++) {
      const u = pre[i], m = links[u];
      for (let d = 0; d < 8; d++) if (m & (1 << d)) links[NB[8 * u + d]] &= ~(1 << (d ^ 2));
      links[u] = 0;
    }
  }
}

/**
 * Builds the cell maze of board (x, y). `doorCells` lists every door cell;
 * the primary pair is (a, b), with b = -1 on a dead-end board. Attempts run
 * k = 0..MAX_REROLL, each repaired by edge swaps; the first to meet every
 * target wins, else the lowest deficit (earliest k on ties) is kept as the
 * best-attempt fallback. The winner is then carved to `carveCells` cells,
 * keeping every door cell, a, b and the flame cell; its figures describe the
 * carved tree.
 */
export function buildBoardMaze(H, x, y, doorCells, a, b, carveCells = CARVE_CELLS) {
  const isDoor = new Uint8Array(NCELL);
  for (const c of doorCells) isDoor[c] = 1;
  const links = new Uint8Array(NCELL);
  let best = null, bestLinks = null;
  for (let k = 0; k <= MAX_REROLL; k++) {
    growTree(sfc32(H('board', x, y, k)), links);
    const r = repairTree(links, a, b, isDoor);
    if (r.deficit === 0) {
      return carved(H, x, y, isDoor, links, { k, fallback: false, ...r }, carveCells);
    }
    if (!best || r.deficit < best.deficit) {
      best = { k, ...r };
      bestLinks = links.slice();
    }
  }
  return carved(H, x, y, isDoor, bestLinks, { fallback: true, ...best }, carveCells);
}

/** The record `won` for `links`, carved and re-measured. */
function carved(H, x, y, isDoor, links, won, carveCells) {
  if (carveCells >= NCELL) return { links, ...won };
  const protect = new Uint8Array(isDoor);
  protect[won.a] = protect[won.b] = 1;
  protect[flameCell(H, x, y)] = 1;
  carve(links, won.a, won.b, isDoor, protect, carveCells, won.deficit, sfc32(H('carve', x, y)));
  const { a, b, pathLen, junctions, shortBranches, deficit } = analyze(links, won.a, won.b, isDoor);
  return { ...won, links, a, b, pathLen, junctions, shortBranches, deficit };
}
