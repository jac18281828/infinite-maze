// Nested-block route (docs/ROUTE.md). A level-k block is a 3x3 grid of level
// k-1 blocks, a level-1 block is one band, and the route crosses each block
// once along a path through its children. Location descends from the start
// chain, so a band's entry and exit derive from H and its coordinates alone.
// Integer arithmetic only.
import { sfc32, u32 } from './hash.mjs';

export const MAX_LEVEL = 20;

// Walls and steps, indexed L R D U.
export const WX = [-1, 1, 0, 0];
export const WY = [0, 0, -1, 1];

// Children are numbered 3 * row + column, row 0 at the bottom.
const CENTRE = 4;
// The child the off-centre fault takes as the start block: bottom middle.
const OFF_CENTRE = 1;

/** floor(a / b) for integers, exact where a / b rounds. */
export function floorDiv(a, b) {
  let q = Math.floor(a / b);
  if (q * b > a) q--;
  else if ((q + 1) * b <= a) q++;
  return q;
}

/** S_k = 3^(k-1), bands per side of a level-k block. */
export function blockSize(k) {
  let s = 1;
  for (let i = 1; i < k; i++) s *= 3;
  return s;
}

/** o_k = -(S_k - 1) / 2, the origin offset of the level-k grid. */
export function blockOrigin(k) {
  return -(blockSize(k) - 1) / 2;
}

/** Index along one axis of the level-k block holding band coordinate n. */
export function blockOf(k, n) {
  return floorDiv(n - blockOrigin(k), blockSize(k));
}

/** The child beside child c across wall w, or -1 off the grid. */
function childStep(c, w) {
  const x = (c % 3) + WX[w], y = ((c / 3) | 0) + WY[w];
  return x < 0 || x > 2 || y < 0 || y > 2 ? -1 : 3 * y + x;
}

/** The wall of child c that faces its neighbour n. */
function wallTo(c, n) {
  for (let w = 0; w < 4; w++) if (childStep(c, w) === n) return w;
  throw new Error(`children ${c} and ${n} are not adjacent`);
}

/**
 * Simple paths from child a to child b over the 3x3 grid, avoiding the
 * children in `blocked` (a bit mask), in depth-first order with neighbours
 * tried L, R, D, U.
 */
function childPaths(a, b, blocked = 0) {
  const out = [];
  if (blocked & (1 << a)) return out;
  const path = [a];
  let seen = blocked | (1 << a);
  function dfs(c) {
    if (c === b) { out.push(path.slice()); return; }
    for (let w = 0; w < 4; w++) {
      const n = childStep(c, w);
      if (n < 0 || seen & (1 << n)) continue;
      seen |= 1 << n;
      path.push(n);
      dfs(n);
      path.pop();
      seen &= ~(1 << n);
    }
  }
  dfs(a);
  return out;
}

/** Paths of at least min(5, longest) children. */
function longEnough(paths) {
  let longest = 0;
  for (const p of paths) if (p.length > longest) longest = p.length;
  const min = Math.min(5, longest);
  return paths.filter((p) => p.length >= min);
}

// Kept section 4 paths per (entry child, exit child); geometry alone.
const KEPT = new Map();

function keptPaths(a, b) {
  const key = 9 * a + b;
  let list = KEPT.get(key);
  if (!list) { list = longEnough(childPaths(a, b)); KEPT.set(key, list); }
  return list;
}

/** The 12 ordered wall pairs (p outer, q inner, p != q), shuffled Fisher-Yates from index 11 down. */
function shuffledPairs(rng) {
  const pairs = [];
  for (let p = 0; p < 4; p++) for (let q = 0; q < 4; q++) if (p !== q) pairs.push([p, q]);
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = rng() % (i + 1);
    const t = pairs[i];
    pairs[i] = pairs[j];
    pairs[j] = t;
  }
  return pairs;
}

/** `path` with a loop round a 2x2 square at its first step, so its first two children repeat. */
function withLoop(path) {
  const [a, b] = path;
  for (let w = 0; w < 4; w++) {
    const q1 = childStep(b, w), q2 = childStep(a, w);
    if (q1 < 0 || q2 < 0 || q1 === a || q2 === b) continue;
    return [a, b, q1, q2, ...path];
  }
  return path;
}

/**
 * The route over the nested blocks of one world. Fault options break one
 * rule each, for the acceptance harness's fault tests:
 * - `revisitLevel`: section 4 block paths at that level repeat a child;
 * - `skewWall` { k, i, j, w }: block (k, i, j) reads wall w one band off;
 * - `offCentre`: the start chain takes the bottom-middle child as centre;
 * - `wrongExit` { u, v }: band (u, v) locates with a wrong exit wall.
 */
export function createRoute(H, { revisitLevel = 0, skewWall = null, offCentre = false, wrongExit = null } = {}) {
  const blocks = new Map();
  const chain = [];

  function refuse(k) {
    if (k > MAX_LEVEL) throw new Error(`route level ${k} is above ${MAX_LEVEL}`);
  }

  /** Crossing offset t on wall w of block (k, i, j), read from that block's side. */
  function offset(k, i, j, w) {
    const S = blockSize(k);
    if (S === 1) return 0;
    const d = w === 0 ? H('vwall', k, i - 1, j) : w === 1 ? H('vwall', k, i, j)
      : w === 2 ? H('hwall', k, i, j - 1) : H('hwall', k, i, j);
    const t = u32(d) % S;
    const skew = skewWall && skewWall.k === k && skewWall.i === i && skewWall.j === j && skewWall.w === w;
    return skew ? (t + 1) % S : t;
  }

  /** The band [u, v] inside block (k, i, j) where the route crosses its wall w. */
  function crossing(k, i, j, w) {
    const S = blockSize(k), o = blockOrigin(k), t = offset(k, i, j, w);
    const u0 = i * S + o, v0 = j * S + o;
    if (w === 0) return [u0, v0 + t];
    if (w === 1) return [u0 + S - 1, v0 + t];
    if (w === 2) return [u0 + t, v0];
    return [u0 + t, v0 + S - 1];
  }

  /** The child of block (k, i, j) holding band [u, v]. */
  function childOf(k, i, j, [u, v]) {
    const S = blockSize(k), s = blockSize(k - 1), o = blockOrigin(k);
    return 3 * floorDiv(v - (j * S + o), s) + floorDiv(u - (i * S + o), s);
  }

  /**
   * Start chain level k: entry wall E, exit wall X and, from level 2, the
   * block path P1 + centre + P2. Null when no wall pair finds a path, which
   * only a fault allows.
   */
  function startChain(k) {
    refuse(k);
    if (chain[k] !== undefined) return chain[k];
    const d = H('start', k);
    let found = null;
    if (k === 1) {
      const E = u32(d) % 4;
      const rest = [0, 1, 2, 3].filter((w) => w !== E);
      found = { k, E, X: rest[u32(d, 4) % 3], path: null };
    } else {
      const below = startChain(k - 1);
      const centre = offCentre ? OFF_CENTRE : CENTRE;
      const nIn = below ? childStep(centre, below.E) : -1, nOut = below ? childStep(centre, below.X) : -1;
      if (nIn >= 0 && nOut >= 0) {
        for (const [E, X] of shuffledPairs(sfc32(d))) {
          const a = childOf(k, 0, 0, crossing(k, 0, 0, E)), b = childOf(k, 0, 0, crossing(k, 0, 0, X));
          const paths = [];
          for (const p1 of childPaths(a, nIn, 1 << centre)) {
            let mask = 1 << centre;
            for (const c of p1) mask |= 1 << c;
            for (const p2 of childPaths(nOut, b, mask)) paths.push([...p1, centre, ...p2]);
          }
          if (!paths.length) continue;
          const kept = longEnough(paths);
          found = { k, E, X, path: kept[u32(d, 4) % kept.length] };
          break;
        }
      }
    }
    chain[k] = found;
    return found;
  }

  /** Section 4 path of a non-start block from its entry child to its exit child. */
  function blockPath(r) {
    const a = childOf(r.k, r.i, r.j, r.entry), b = childOf(r.k, r.i, r.j, r.exit);
    if (a === b) return [a];
    const kept = keptPaths(a, b);
    const path = kept[u32(H('route', r.k, r.i, r.j)) % kept.length];
    return revisitLevel === r.k ? withLoop(path) : path;
  }

  /** Route of the start block (k, 0, 0). */
  function startRoute(k) {
    const c = startChain(k);
    if (!c) throw new Error(`start chain level ${k} finds no path`);
    return { k, i: 0, j: 0, E: c.E, X: c.X, entry: crossing(k, 0, 0, c.E), exit: crossing(k, 0, 0, c.X), path: c.path };
  }

  /**
   * Route of the child at index t of `parent`'s path: entry wall E and exit
   * wall X, the bands `entry` and `exit` just inside them and, above level
   * 1, the child path.
   */
  function childRoute(parent, t) {
    const p = parent.path, c = p[t], k = parent.k - 1;
    const i = 3 * parent.i - 1 + (c % 3), j = 3 * parent.j - 1 + ((c / 3) | 0);
    if (i === 0 && j === 0) return startRoute(k);
    const last = t === p.length - 1;
    const E = t === 0 ? parent.E : wallTo(c, p[t - 1]);
    let X = last ? parent.X : wallTo(c, p[t + 1]);
    if (k === 1 && wrongExit && wrongExit.u === i && wrongExit.v === j) X = [0, 1, 2, 3].find((w) => w !== E && w !== X);
    const r = {
      k, i, j, E, X,
      // The first and last child inherit the parent's crossing; the others cross a level-k wall.
      entry: t === 0 ? parent.entry : crossing(k, i, j, E),
      exit: last ? parent.exit : crossing(k, i, j, X),
      path: null,
    };
    if (k > 1) r.path = blockPath(r);
    return r;
  }

  /** Route of block (k, i, j), cached; null for a block off its parent's path, which is rock. */
  function blockRoute(k, i, j) {
    refuse(k);
    const key = `${k},${i},${j}`;
    if (blocks.has(key)) return blocks.get(key);
    let r;
    if (i === 0 && j === 0) r = startRoute(k);
    else {
      const parent = blockRoute(k + 1, floorDiv(i + 1, 3), floorDiv(j + 1, 3));
      const c = 3 * (j - 3 * floorDiv(j + 1, 3) + 1) + (i - 3 * floorDiv(i + 1, 3) + 1);
      const t = parent ? parent.path.indexOf(c) : -1;
      r = t >= 0 ? childRoute(parent, t) : null;
    }
    blocks.set(key, r);
    return r;
  }

  /** Section 6 location of band (u, v): its entry and exit walls, or null for rock. */
  function locate(u, v) {
    const r = blockRoute(1, u, v);
    return r ? { E: r.E, X: r.X } : null;
  }

  /** Highest start chain level built so far, 0 before any. */
  function startLevel() {
    return Math.max(0, chain.length - 1);
  }

  return { startChain, startRoute, childRoute, blockRoute, locate, crossing, childOf, startLevel };
}
