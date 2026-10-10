// The world: band trees placed by the nested route, boards with doors, flames
// and the cell graph across seams. Bands tile the plane. Everything derives
// from H; caches only memoize.
import { makeHasher, worldKey, u32, toHex, writeInt64BE } from './hash.mjs';
import { sha3_256 } from './keccak.mjs';
import { BW, BH, NCELL, COST, CARVE_CELLS, buildBoardMaze, cellNeighbor, flameCell } from './board.mjs';
import { BANDW, BANDH, NBOARD, BDX, BDY, WALL_DIR, buildBandTree, rockBand } from './band.mjs';
import { createRoute, WX, WY } from './route.mjs';

export const GAP_LIMIT_MS = 150000;
// Saves hold |x| and |y| below 2^25, where p stays an exact integer.
export const SAVE_LIMIT = 33554432;

/** Band (u, v) holding board (x, y). */
export function bandOf(x, y) {
  return { u: Math.floor(x / BANDW), v: Math.floor(y / BANDH) };
}

/** Ring of band (u, v), max(|u|, |v|): the score. */
export function ringOf(u, v) {
  return Math.max(Math.abs(u), Math.abs(v));
}

const zig = (n) => (n >= 0 ? 2 * n : -2 * n - 1);
const unzig = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/** Save position of board (x, y), the docs/ROUTE.md section 8 pairing of z(x) and z(y). */
export function posOf(x, y) {
  const a = zig(x), b = zig(y);
  return a >= b ? a * a + a + b : a + b * b;
}

/** Largest s with s * s <= n, for 0 <= n < 2^53. */
function isqrt(n) {
  let lo = 0, hi = 94906265;
  while (lo < hi) {
    const m = lo + Math.floor((hi - lo + 1) / 2);
    if (m * m <= n) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/** Board (x, y) of save position p; inverts posOf. */
export function boardOfPos(p) {
  const s = isqrt(p), r = p - s * s;
  return r < s ? { x: unzig(r), y: unzig(s) } : { x: unzig(s), y: unzig(r - s) };
}

/** Board (x, y) at index i = 6 * row + column within band (u, v). */
export function boardCoords(u, v, i) {
  return { x: BANDW * u + (i % BANDW), y: BANDH * v + ((i / BANDW) | 0) };
}

/** Index of board (x, y) within its band. */
export function boardIndex(x, y) {
  const { u, v } = bandOf(x, y);
  return (y - BANDH * v) * BANDW + (x - BANDW * u);
}

/** Door cell on wall d (E N W S) of board (x, y); both sides read one key. */
export function doorCell(H, x, y, d) {
  switch (d) {
    case 0: return (u32(H('hdoor', x, y)) % 5 + 1) * BW + (BW - 1);
    case 2: return (u32(H('hdoor', x - 1, y)) % 5 + 1) * BW;
    case 1: return (BH - 1) * BW + u32(H('vdoor', x, y)) % 10 + 1;
    default: return u32(H('vdoor', x, y - 1)) % 10 + 1;
  }
}

/** The cell across wall d from a door cell of the neighbouring board. */
export function acrossDoor(cell, d) {
  switch (d) {
    case 0: return cell - (BW - 1);
    case 2: return cell + (BW - 1);
    case 1: return cell - (BH - 1) * BW;
    default: return cell + (BH - 1) * BW;
  }
}

function dirBetween(i, n) {
  if (n === i + 1) return 0;
  if (n === i - 1) return 2;
  return n > i ? 1 : 3;
}

/** First index of `cum` at or past half of `total`. */
export function midpointIndex(cum, total) {
  let j = 0;
  while (2 * cum[j] < total) j++;
  return j;
}

/**
 * Door directions of board i in band tree t: `aDir` leads back toward the
 * band entry, `bDir` along the route toward the exit (-1 off the route),
 * `dirs` holds all. The first and last route boards open onto the band's
 * entry and exit walls.
 */
function boardLinks(t, i) {
  const r = t.routeIndex[i], L = t.route.length;
  let aDir, bDir = -1;
  if (r >= 0) {
    aDir = r > 0 ? dirBetween(i, t.route[r - 1]) : WALL_DIR[t.entryWall];
    bDir = r < L - 1 ? dirBetween(i, t.route[r + 1]) : WALL_DIR[t.exitWall];
  } else {
    aDir = dirBetween(i, t.parent[i]);
  }
  const dirs = bDir >= 0 ? [aDir, bDir] : [aDir];
  for (let n = 0; n < NBOARD; n++) if (t.parent[n] === i) dirs.push(dirBetween(i, n));
  dirs.sort((u, v) => u - v);
  return { aDir, bDir, dirs };
}

/**
 * Cells and cumulative walking times from flame A to flame B, where
 * `at(pos)` is the board at route position pos and A.pos <= B.pos.
 */
function routePath(at, A, B) {
  const cells = [], cum = [];
  let ms = 0;
  for (let pos = A.pos; pos <= B.pos; pos++) {
    const bd = at(pos);
    const seg = cellPath(bd.links, pos === A.pos ? A.cell : bd.a, pos === B.pos ? B.cell : bd.b);
    for (let j = 0; j < seg.cells.length; j++) {
      if (j > 0) ms += COST[seg.dirs[j - 1]];
      cells.push({ pos, cell: seg.cells[j] });
      cum.push(ms);
    }
    if (pos < B.pos) ms += COST[bd.bDir];
  }
  return { cells, cum, total: ms };
}

/** Cells and link directions of the tree path from `from` to `to`. */
export function cellPath(links, from, to) {
  const parent = new Int16Array(NCELL).fill(-1);
  const pdir = new Int8Array(NCELL);
  const queue = [from];
  parent[from] = from;
  for (let h = 0; h < queue.length && parent[to] < 0; h++) {
    const c = queue[h];
    for (let d = 0; d < 8; d++) {
      if (!(links[c] & (1 << d))) continue;
      const t = cellNeighbor(c, d);
      if (parent[t] >= 0) continue;
      parent[t] = c;
      pdir[t] = d;
      queue.push(t);
    }
  }
  const cells = [], dirs = [];
  for (let c = to; c !== from; c = parent[c]) { cells.push(c); dirs.push(pdir[c]); }
  cells.push(from);
  cells.reverse();
  dirs.reverse();
  return { cells, dirs };
}

/**
 * `gapLimitMs` bounds the walking time between consecutive route flames;
 * spec section 3 sets 150 s. `carveCells` sets the cells each board keeps;
 * NCELL keeps them all. The route's fault options pass to createRoute. The
 * `wrongExit` { u, v } fault gives band (u, v) a wrong exit wall in the
 * location `locate` returns, while its band tree keeps the true route.
 */
export function createWorld(code, options = {}) {
  const { gapLimitMs = GAP_LIMIT_MS, carveCells = CARVE_CELLS, wrongExit = null } = options;
  const H = makeHasher(worldKey(code));
  const route = createRoute(H, options);
  const trees = new Map();
  const boards = new Map();
  const flameSets = new Map();
  const flameCells = new Map();
  const key = (a, b) => `${a},${b}`;

  function tree(u, v) {
    const k = key(u, v);
    let t = trees.get(k);
    if (!t) {
      const loc = route.locate(u, v);
      t = loc ? buildBandTree(H, u, v, loc.E, loc.X) : rockBand(u, v);
      trees.set(k, t);
    }
    return t;
  }

  function board(x, y) {
    const k = key(x, y);
    let bd = boards.get(k);
    if (!bd) { bd = buildBoard(x, y); boards.set(k, bd); }
    return bd;
  }

  function buildBoard(x, y) {
    const { u, v } = bandOf(x, y);
    const t = tree(u, v);
    const i = (y - BANDH * v) * BANDW + (x - BANDW * u);
    const base = { x, y, p: posOf(x, y), u, v, index: i, routeIndex: t.routeIndex[i], depth: t.depth[i] };
    if (t.depth[i] < 0) return { ...base, kind: 'rock', doors: [], links: null, doorMask: null };
    const { aDir, bDir, dirs } = boardLinks(t, i);
    const doors = dirs.map((d) => ({ dir: d, cell: doorCell(H, x, y, d) }));
    const doorMask = new Uint8Array(NCELL);
    for (const dr of doors) doorMask[dr.cell] |= 1 << dr.dir;
    const a = doors.find((dr) => dr.dir === aDir).cell;
    const b = bDir >= 0 ? doors.find((dr) => dr.dir === bDir).cell : -1;
    const maze = buildBoardMaze(H, x, y, doors.map((dr) => dr.cell), a, b, carveCells);
    return {
      ...base, kind: t.routeIndex[i] >= 0 ? 'route' : 'dead', doors, doorMask, aDir, bDir,
      links: maze.links, a: maze.a, b: maze.b, k: maze.k, fallback: maze.fallback,
      pathLen: maze.pathLen, junctions: maze.junctions, deficit: maze.deficit,
    };
  }

  /** The route band after (u, v), through its exit wall; null for rock. */
  function next(u, v) {
    const loc = route.locate(u, v);
    return loc ? { u: u + WX[loc.X], v: v + WY[loc.X] } : null;
  }

  /** The route band before (u, v), through its entry wall; null for rock. */
  function prev(u, v) {
    const loc = route.locate(u, v);
    return loc ? { u: u + WX[loc.E], v: v + WY[loc.E] } : null;
  }

  /** Section 6 location of band (u, v): { E, X } walls, or null for rock. */
  function locate(u, v) {
    const loc = route.locate(u, v);
    if (!loc || !wrongExit || wrongExit.u !== u || wrongExit.v !== v) return loc;
    return { E: loc.E, X: [0, 1, 2, 3].find((w) => w !== loc.E && w !== loc.X) };
  }

  /** Entry board of band (u, v), or null for a rock band. */
  function entryBoard(u, v) {
    const t = tree(u, v);
    if (t.rock) return null;
    const { x, y } = boardCoords(u, v, t.entry);
    return board(x, y);
  }

  /** Board at route position pos of band (u, v); pos = route length is the next band's entry. */
  function routeBoard(u, v, pos) {
    const t = tree(u, v);
    if (pos === t.route.length) {
      const n = next(u, v);
      return entryBoard(n.u, n.v);
    }
    const { x, y } = boardCoords(u, v, t.route[pos]);
    return board(x, y);
  }

  function routeFlame(bd, pos) {
    return { x: bd.x, y: bd.y, cell: flameCell(H, bd.x, bd.y), kind: 'route', pos };
  }

  /** Flames on every third route board from the entry, then the next band's entry flame. */
  function routeChain(u, v) {
    const L = tree(u, v).route.length;
    const chain = [];
    for (let pos = 0; pos < L; pos += 3) chain.push(routeFlame(routeBoard(u, v, pos), pos));
    chain.push(routeFlame(routeBoard(u, v, L), L));
    return chain;
  }

  /** Dead-end boards with flame byte 0 below 128 burn at their deepest cell. */
  function deadEndFlames(u, v) {
    const t = tree(u, v);
    const out = [];
    for (let i = 0; i < NBOARD; i++) {
      if (t.depth[i] <= 0) continue;
      const { x, y } = boardCoords(u, v, i);
      if (H('flame', x, y)[0] < 128) out.push({ x, y, cell: board(x, y).b, kind: 'dead', pos: -1 });
    }
    return out;
  }

  /**
   * Inserts a flame at the midpoint cell of each chain gap over the limit
   * until none remains; returns the inserted flames and the final gaps.
   */
  function splitGaps(u, v, chain) {
    const at = (pos) => routeBoard(u, v, pos);
    const added = [], gaps = [];
    for (let i = 0; i + 1 < chain.length;) {
      const path = routePath(at, chain[i], chain[i + 1]);
      if (path.total > gapLimitMs) {
        const { pos, cell } = path.cells[midpointIndex(path.cum, path.total)];
        const bd = at(pos);
        const f = { x: bd.x, y: bd.y, cell, kind: 'gap', pos };
        added.push(f);
        chain.splice(i + 1, 0, f);
      } else {
        gaps.push(path.total);
        i++;
      }
    }
    return { added, gaps };
  }

  /**
   * Flames of band (u, v) and its chain of route flames, ordered along the
   * route and ending at the next route band's entry flame. A rock band has none.
   */
  function bandFlames(u, v) {
    const k = key(u, v);
    let fs = flameSets.get(k);
    if (fs) return fs;
    if (tree(u, v).rock) fs = { u, v, flames: [], chain: [], gaps: [] };
    else {
      const chain = routeChain(u, v);
      const routeFlames = chain.slice(0, -1);
      const dead = deadEndFlames(u, v);
      const { added, gaps } = splitGaps(u, v, chain);
      fs = { u, v, flames: [...routeFlames, ...dead, ...added], chain, gaps };
    }
    flameSets.set(k, fs);
    return fs;
  }

  /** Flame cells on board (x, y), ascending; the previous route band may light a band's entry. */
  function flamesAt(x, y) {
    const k = key(x, y);
    let cells = flameCells.get(k);
    if (cells) return cells;
    const { u, v } = bandOf(x, y);
    const t = tree(u, v);
    const i = (y - BANDH * v) * BANDW + (x - BANDW * u);
    const set = new Set();
    if (t.depth[i] >= 0) {
      for (const f of bandFlames(u, v).flames) if (f.x === x && f.y === y) set.add(f.cell);
      if (t.routeIndex[i] === 0) {
        const p = prev(u, v);
        for (const f of bandFlames(p.u, p.v).flames) if (f.x === x && f.y === y) set.add(f.cell);
      }
    }
    cells = [...set].sort((a, b) => a - b);
    flameCells.set(k, cells);
    return cells;
  }

  /** Neighbour of `cell` on board `bd` through link or door d, or null. */
  function step(bd, cell, d) {
    if (!bd.links) return null;
    if (bd.links[cell] & (1 << d)) return { board: bd, cell: cellNeighbor(cell, d) };
    if (d < 4 && (bd.doorMask[cell] & (1 << d))) {
      const nb = board(bd.x + BDX[d], bd.y + BDY[d]);
      const nc = acrossDoor(cell, d);
      if (nb.doorMask && (nb.doorMask[nc] & (1 << (d ^ 2)))) return { board: nb, cell: nc };
    }
    return null;
  }

  /** The start band's entry: band (0, 0)'s entry board at its entry door. */
  function startPoint() {
    const bd = entryBoard(0, 0);
    return { board: bd, cell: bd.a };
  }

  /**
   * Where a resumed run starts on board (x, y): the door leading back toward
   * the band entry. A rock board of a route band resumes at that band's
   * entry, and a board of a rock band at the start band's entry.
   */
  function resumePoint(x, y) {
    let bd = board(x, y);
    if (bd.kind === 'rock') bd = tree(bd.u, bd.v).rock ? entryBoard(0, 0) : entryBoard(bd.u, bd.v);
    return { board: bd, cell: bd.a };
  }

  /** Drops cached bands, flames and boards more than one band from band (u, v). */
  function retain(u, v) {
    const far = (bu, bv) => Math.abs(bu - u) > 1 || Math.abs(bv - v) > 1;
    for (const [k, t] of trees) if (far(t.u, t.v)) trees.delete(k);
    for (const [k, fs] of flameSets) if (far(fs.u, fs.v)) flameSets.delete(k);
    for (const [k, bd] of boards) if (far(bd.u, bd.v)) boards.delete(k);
    for (const k of flameCells.keys()) {
      const [x, y] = k.split(',').map(Number);
      const b = bandOf(x, y);
      if (far(b.u, b.v)) flameCells.delete(k);
    }
  }

  return {
    code, options, H, tree, board, entryBoard, next, prev, locate, startChain: route.startChain,
    startLevel: route.startLevel, startPoint, bandFlames, flamesAt, step, resumePoint, retain,
  };
}

/**
 * Route bands i0..i1 in route order, each { u, v, index }, walked from band
 * (0, 0) by the generator: exits count up, entries count down.
 */
export function routeBands(world, i0, i1) {
  let b = { u: 0, v: 0, index: 0 };
  const fwd = [b], back = [];
  for (let i = 1; i <= i1; i++) fwd.push(b = { ...world.next(b.u, b.v), index: i });
  b = fwd[0];
  for (let i = -1; i >= i0; i--) back.push(b = { ...world.prev(b.u, b.v), index: i });
  const out = [];
  for (let i = i0; i <= i1; i++) out.push(i < 0 ? back[-i - 1] : fwd[i]);
  return out;
}

class Bytes {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 255); }
  i64(n) {
    const b = new Uint8Array(8);
    writeInt64BE(b, 0, n);
    this.bytes(b);
  }
  bytes(b) { for (const v of b) this.a.push(v); }
  done() { return Uint8Array.from(this.a); }
}

/** Canonical bytes of a board: layout, maze, doors and flames. */
export function serializeBoard(world, x, y) {
  const bd = world.board(x, y);
  const w = new Bytes();
  w.i64(x); w.i64(y);
  w.u8(bd.kind === 'rock' ? 0 : bd.kind === 'route' ? 1 : 2);
  w.u8(bd.routeIndex); w.u8(bd.depth);
  if (bd.kind !== 'rock') {
    w.u8(bd.k); w.u8(bd.fallback ? 1 : 0); w.u8(bd.a); w.u8(bd.b);
    w.u8(bd.doors.length);
    for (const dr of bd.doors) { w.u8(dr.dir); w.u8(dr.cell); }
    w.bytes(bd.links);
    const fl = world.flamesAt(x, y);
    w.u8(fl.length);
    w.bytes(fl);
  }
  return w.done();
}

/** SHA3-256 hex digest over every board and flame chain of route bands i0..i1. */
export function digestBands(world, i0, i1) {
  const parts = [];
  for (const { u, v } of routeBands(world, i0, i1)) {
    const t = world.tree(u, v);
    const w = new Bytes();
    w.i64(u); w.i64(v); w.u8(t.k); w.u8(t.entryWall); w.u8(t.exitWall);
    w.u8(t.route.length); w.bytes(t.route);
    const fs = world.bandFlames(u, v);
    w.u8(fs.chain.length);
    for (const f of fs.chain) { w.i64(f.x); w.i64(f.y); w.u8(f.cell); }
    parts.push(w.done());
    for (let i = 0; i < NBOARD; i++) {
      const { x, y } = boardCoords(u, v, i);
      parts.push(serializeBoard(world, x, y));
    }
  }
  let n = 0;
  for (const p of parts) n += p.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return toHex(sha3_256(all));
}
