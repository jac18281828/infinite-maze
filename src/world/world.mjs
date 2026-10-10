// The world: band trees, boards with doors, flames and the cell graph across
// seams. Everything derives from H; caches only memoize.
import { makeHasher, worldKey, u32, toHex, writeInt64BE } from './hash.mjs';
import { sha3_256 } from './keccak.mjs';
import { BW, BH, NCELL, COST, CARVE_CELLS, buildBoardMaze, cellNeighbor, flameCell } from './board.mjs';
import { BANDW, BANDH, NBOARD, BDX, BDY, buildBandTree } from './band.mjs';

export const GAP_LIMIT_MS = 150000;

export function bandOf(y) {
  return Math.floor(y / BANDH);
}

export function posOf(x, y) {
  return BANDW * y + x;
}

export function boardOfPos(p) {
  const y = Math.floor(p / BANDW);
  return { x: p - BANDW * y, y };
}

/** Board (x, y) at index i = 6 * row + x within band b. */
export function boardCoords(b, i) {
  return { x: i % BANDW, y: BANDH * b + ((i / BANDW) | 0) };
}

/** Index of board (x, y) within its band. */
export function boardIndex(x, y) {
  return (y - BANDH * bandOf(y)) * BANDW + x;
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
 * band entry, `bDir` up the route (-1 off the route), `dirs` holds all.
 */
function boardLinks(t, i) {
  const r = t.routeIndex[i], L = t.route.length;
  let aDir, bDir = -1;
  if (r >= 0) {
    aDir = r > 0 ? dirBetween(i, t.route[r - 1]) : 3;
    bDir = r < L - 1 ? dirBetween(i, t.route[r + 1]) : 1;
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
 * NCELL keeps them all.
 */
export function createWorld(code, { gapLimitMs = GAP_LIMIT_MS, carveCells = CARVE_CELLS } = {}) {
  const H = makeHasher(worldKey(code));
  const trees = new Map();
  const boards = new Map();
  const flameSets = new Map();
  const flameCells = new Map();

  function tree(b) {
    let t = trees.get(b);
    if (!t) { t = buildBandTree(H, b); trees.set(b, t); }
    return t;
  }

  function board(x, y) {
    const p = posOf(x, y);
    let bd = boards.get(p);
    if (!bd) { bd = buildBoard(x, y, p); boards.set(p, bd); }
    return bd;
  }

  function buildBoard(x, y, p) {
    const band = bandOf(y);
    const t = tree(band);
    const i = boardIndex(x, y);
    const base = { x, y, p, band, index: i, routeIndex: t.routeIndex[i], depth: t.depth[i] };
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

  /** Board at route position pos of band b; pos = route length is band b+1's entry. */
  function routeBoard(b, pos) {
    const t = tree(b);
    if (pos === t.route.length) return board(tree(b + 1).entryX, BANDH * (b + 1));
    const { x, y } = boardCoords(b, t.route[pos]);
    return board(x, y);
  }

  function routeFlame(bd, pos) {
    return { x: bd.x, y: bd.y, cell: flameCell(H, bd.x, bd.y), kind: 'route', pos };
  }

  /** Flames on every third route board from the entry, then band b+1's entry flame. */
  function routeChain(b) {
    const L = tree(b).route.length;
    const chain = [];
    for (let pos = 0; pos < L; pos += 3) chain.push(routeFlame(routeBoard(b, pos), pos));
    chain.push(routeFlame(routeBoard(b, L), L));
    return chain;
  }

  /** Dead-end boards with flame byte 0 below 128 burn at their deepest cell. */
  function deadEndFlames(b) {
    const t = tree(b);
    const out = [];
    for (let i = 0; i < NBOARD; i++) {
      if (t.depth[i] <= 0) continue;
      const { x, y } = boardCoords(b, i);
      if (H('flame', x, y)[0] < 128) out.push({ x, y, cell: board(x, y).b, kind: 'dead', pos: -1 });
    }
    return out;
  }

  /**
   * Inserts a flame at the midpoint cell of each chain gap over the limit
   * until none remains; returns the inserted flames and the final gaps.
   */
  function splitGaps(b, chain) {
    const at = (pos) => routeBoard(b, pos);
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
   * Flames of band b and its chain of route flames, ordered up the route and
   * ending at band b+1's entry flame.
   */
  function bandFlames(b) {
    let fs = flameSets.get(b);
    if (fs) return fs;
    const chain = routeChain(b);
    const route = chain.slice(0, -1);
    const dead = deadEndFlames(b);
    const { added, gaps } = splitGaps(b, chain);
    fs = { b, flames: [...route, ...dead, ...added], chain, gaps };
    flameSets.set(b, fs);
    return fs;
  }

  /** Flame cells on board (x, y), ascending; band b-1 may light b's entry. */
  function flamesAt(x, y) {
    const p = posOf(x, y);
    let cells = flameCells.get(p);
    if (cells) return cells;
    const b = bandOf(y);
    const t = tree(b);
    const set = new Set();
    if (t.depth[boardIndex(x, y)] >= 0) {
      for (const f of bandFlames(b).flames) if (f.x === x && f.y === y) set.add(f.cell);
      if (y === BANDH * b && x === t.entryX) {
        for (const f of bandFlames(b - 1).flames) if (f.x === x && f.y === y) set.add(f.cell);
      }
    }
    cells = [...set].sort((u, v) => u - v);
    flameCells.set(p, cells);
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

  /**
   * Where a resumed run starts on board (x, y): the door leading back toward
   * the band entry. A rock board resumes at its band's entry instead.
   */
  function resumePoint(x, y) {
    let bd = board(x, y);
    if (bd.kind === 'rock') {
      const b = bandOf(y);
      bd = board(tree(b).entryX, BANDH * b);
    }
    return { board: bd, cell: bd.a };
  }

  /** Drops cached bands outside [lo, hi] and their boards. */
  function retain(lo, hi) {
    for (const b of trees.keys()) if (b < lo || b > hi) trees.delete(b);
    for (const b of flameSets.keys()) if (b < lo || b > hi) flameSets.delete(b);
    for (const [p, bd] of boards) if (bd.band < lo || bd.band > hi) boards.delete(p);
    for (const p of flameCells.keys()) {
      const b = bandOf(boardOfPos(p).y);
      if (b < lo || b > hi) flameCells.delete(p);
    }
  }

  return { code, H, tree, board, bandFlames, flamesAt, step, resumePoint, retain };
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

/** SHA3-256 hex digest over every board and flame chain of bands b0..b1. */
export function digestBands(world, b0, b1) {
  const parts = [];
  for (let b = b0; b <= b1; b++) {
    const t = world.tree(b);
    const w = new Bytes();
    w.i64(b); w.u8(t.k); w.u8(t.entryX); w.u8(t.exitX);
    w.u8(t.route.length); w.bytes(t.route);
    const fs = world.bandFlames(b);
    w.u8(fs.chain.length);
    for (const f of fs.chain) { w.i64(f.x); w.i64(f.y); w.u8(f.cell); }
    parts.push(w.done());
    for (let i = 0; i < NBOARD; i++) {
      const { x, y } = boardCoords(b, i);
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
