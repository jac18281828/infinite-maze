// The world: tombs tiling the plane, their band trees, boards with doors,
// flames and the cell graph across seams. Everything derives from H; caches
// only memoize.
import { makeHasher, worldKey, u32, toHex, writeInt64BE } from './hash.mjs';
import { sha3_256 } from './keccak.mjs';
import { BW, BH, NCELL, COST, CARVE_CELLS, buildBoardMaze, cellNeighbor, flameCell } from './board.mjs';
import { DIFFICULTY, BDX, BDY, buildTombTree } from './band.mjs';
import { createFlow, TDX, TDY } from './flow.mjs';

export const GAP_LIMIT_MS = 150000;
// Saves hold |x| and |y| below 2^25, where p stays an exact integer.
export const SAVE_LIMIT = 33554432;

/** Tomb (u, v) holding board (x, y), for tombs of `size` boards. */
export function tombOf(x, y, size) {
  return { u: Math.floor(x / size.w), v: Math.floor(y / size.h) };
}

const zig = (n) => (n >= 0 ? 2 * n : -2 * n - 1);
const unzig = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/** Save position of board (x, y): the pairing of z(x) and z(y). */
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

/** Board (x, y) of save position p >= 0; inverts posOf. */
export function boardOfPos(p) {
  const s = isqrt(p), r = p - s * s;
  return r < s ? { x: unzig(r), y: unzig(s) } : { x: unzig(s), y: unzig(r - s) };
}

/** Board (x, y) at index i = W * row + column within tomb (u, v) of `size` boards. */
export function boardCoords(u, v, i, size) {
  return { x: size.w * u + (i % size.w), y: size.h * v + ((i / size.w) | 0) };
}

/** Index of board (x, y) within its tomb of `size` boards. */
export function boardIndex(x, y, size) {
  const { u, v } = tombOf(x, y, size);
  return (y - size.h * v) * size.w + (x - size.w * u);
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

/** A rock board: no doors, links or door mask. */
function rock(base) {
  return { ...base, kind: 'rock', doors: [], links: null, doorMask: null };
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
 * Door directions of board i in tomb tree t: `aDir` leads back along its
 * route (the in-door on an entry, -1 on a source board S), or to a dead
 * end's parent; `bDir` leads on along the route (the exit wall on X), else
 * -1; `dirs` holds every door: toward each tree neighbour and through each
 * tomb wall the board carries.
 */
function boardLinks(t, i) {
  const dirs = new Set();
  if (t.next[i] >= 0) dirs.add(dirBetween(i, t.next[i]));
  for (let n = 0; n < t.next.length; n++) if (t.next[n] === i) dirs.add(dirBetween(i, n));
  for (const w of t.walls) if (w.i === i) dirs.add(w.dir);
  const r = t.routeIndex[i];
  let aDir, bDir = -1;
  if (r >= 0) {
    const route = t.routes[t.routeOf[i]];
    aDir = r > 0 ? dirBetween(i, route[r - 1]) : t.routeEntry[t.routeOf[i]];
    if (t.next[i] >= 0) bDir = dirBetween(i, t.next[i]);
    else if (i === t.X) bDir = t.exit;
  } else {
    aDir = dirBetween(i, t.next[i]);
  }
  return { aDir, bDir, dirs: [...dirs].sort((p, q) => p - q) };
}

/**
 * Cells and cumulative walking times from flame A to flame B along `span`,
 * a list of { bd, inCell, outCell, outDir }, where A.pos <= B.pos.
 */
function spanPath(span, A, B) {
  const cells = [], cum = [];
  let ms = 0;
  for (let pos = A.pos; pos <= B.pos; pos++) {
    const st = span[pos];
    const seg = cellPath(st.bd.links, pos === A.pos ? A.cell : st.inCell, pos === B.pos ? B.cell : st.outCell);
    for (let j = 0; j < seg.cells.length; j++) {
      if (j > 0) ms += COST[seg.dirs[j - 1]];
      cells.push({ pos, cell: seg.cells[j] });
      cum.push(ms);
    }
    if (pos < B.pos) ms += COST[st.outDir];
  }
  return { cells, cum, total: ms };
}

/**
 * `cells` on board `bd` in walking order from `inCell` toward `outCell`:
 * by where each one's path from `inCell` leaves the main line, then by its
 * distance off the line, then by cell.
 */
function walkOrder(bd, inCell, outCell, cells) {
  const main = cellPath(bd.links, inCell, outCell).cells;
  const keyed = cells.map((c) => {
    const p = cellPath(bd.links, inCell, c).cells;
    let k = 0;
    while (k + 1 < p.length && k + 1 < main.length && p[k + 1] === main[k + 1]) k++;
    return { c, k, off: p.length - 1 - k };
  });
  keyed.sort((p, q) => p.k - q.k || p.off - q.off || p.c - q.c);
  return keyed.map((e) => e.c);
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
 * `difficulty` ('easy', 'medium' or 'hard') sets the tomb size and enters no
 * hash. `gapLimitMs` bounds the walking time between consecutive chain
 * flames; spec section 3 sets 150 s. `carveCells` sets the cells each board
 * keeps; NCELL keeps them all. `faults` builds a broken world for the
 * harness's tests: `ignoreWalls` (see createFlow) or `dropTributary` (see
 * buildTombTree).
 */
export function createWorld(code, { difficulty = 'hard', gapLimitMs = GAP_LIMIT_MS, carveCells = CARVE_CELLS, faults = {} } = {}) {
  if (!Object.hasOwn(DIFFICULTY, difficulty)) throw new Error(`unknown difficulty ${difficulty}`);
  const size = DIFFICULTY[difficulty];
  const H = makeHasher(worldKey(code));
  const flow = createFlow(H, size, faults);
  const tombs = new Map();
  const boards = new Map();
  const flameSets = new Map();
  const flameCells = new Map();
  const tkey = (u, v) => `${u},${v}`;

  function tomb(u, v) {
    const k = tkey(u, v);
    let t = tombs.get(k);
    if (!t) { t = buildTombTree(H, u, v, flow.walls(u, v), size, faults); tombs.set(k, t); }
    return t;
  }

  function board(x, y) {
    const p = posOf(x, y);
    let bd = boards.get(p);
    if (!bd) { bd = buildBoard(x, y, p); boards.set(p, bd); }
    return bd;
  }

  function buildBoard(x, y, p) {
    const { u, v } = tombOf(x, y, size);
    const t = tomb(u, v);
    const i = boardIndex(x, y, size);
    const base = {
      x, y, p, u, v, index: i, routeIndex: t.routeIndex[i], depth: t.depth[i], entry: t.entries.includes(i),
    };
    if (t.depth[i] < 0) return rock(base);
    const { aDir, bDir, dirs } = boardLinks(t, i);
    const doors = dirs.map((d) => ({ dir: d, cell: doorCell(H, x, y, d) }));
    const doorMask = new Uint8Array(NCELL);
    for (const dr of doors) doorMask[dr.cell] |= 1 << dr.dir;
    // A source board S starts its route at its flame cell. When that cell is
    // the door the route leaves by, the pair measures to the deepest cell
    // instead, as a dead end's does.
    const a = aDir >= 0 ? doorCell(H, x, y, aDir) : flameCell(H, x, y);
    let b = bDir >= 0 ? doorCell(H, x, y, bDir) : -1;
    if (b === a) b = -1;
    const maze = buildBoardMaze(H, x, y, doors.map((dr) => dr.cell), a, b, carveCells);
    return {
      ...base, kind: t.routeIndex[i] >= 0 ? 'route' : 'dead', doors, doorMask, aDir, bDir,
      links: maze.links, a: maze.a, b: maze.b, k: maze.k, fallback: maze.fallback,
      pathLen: maze.pathLen, junctions: maze.junctions, deficit: maze.deficit,
    };
  }

  function boardAt(t, i) {
    const { x, y } = boardCoords(t.u, t.v, i, size);
    return board(x, y);
  }

  /**
   * The way on of entry j of tomb t: its boards from the entry along the
   * route to X, then across the exit wall to the downstream entry board.
   * Each step holds the cell it is entered at (the entry's flame cell on
   * the first), the cell it is left at and the direction it is left by; the
   * downstream board is left at its flame cell.
   */
  function entrySpan(t, j) {
    const path = [t.entries[j]];
    while (t.next[path[path.length - 1]] >= 0) path.push(t.next[path[path.length - 1]]);
    const span = path.map((i, pos) => {
      const bd = boardAt(t, i);
      const inCell = pos === 0 ? flameCell(H, bd.x, bd.y) : doorCell(H, bd.x, bd.y, dirBetween(i, path[pos - 1]));
      const outDir = pos + 1 < path.length ? dirBetween(i, path[pos + 1]) : i === t.X ? t.exit : -1;
      const outCell = outDir >= 0 ? doorCell(H, bd.x, bd.y, outDir) : inCell;
      return { bd, inCell, outCell, outDir };
    });
    const last = span[span.length - 1];
    if (last.outDir >= 0) {
      const bd = board(last.bd.x + BDX[last.outDir], last.bd.y + BDY[last.outDir]);
      span.push({ bd, inCell: acrossDoor(last.outCell, last.outDir), outCell: flameCell(H, bd.x, bd.y), outDir: -1, down: true });
    }
    return span;
  }

  /**
   * Inserts a flame at the midpoint cell of each chain gap over the limit
   * until none remains; returns the inserted flames and the final gaps.
   */
  function splitGaps(span, chain) {
    const added = [], gaps = [];
    for (let i = 0; i + 1 < chain.length;) {
      const path = spanPath(span, chain[i], chain[i + 1]);
      if (path.total > gapLimitMs) {
        const { pos, cell } = path.cells[midpointIndex(path.cum, path.total)];
        const bd = span[pos].bd;
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
   * Flames tomb (u, v) places and one chain per entry. Entries and every
   * third board along each route burn at their flame cells; half the dead
   * ends burn at their deepest cells. Each entry's chain runs from its flame
   * along its way on to the downstream entry's flame, taking the flames on
   * its boards that the routes and earlier chains placed, and gains a
   * midpoint flame in every gap over the limit.
   */
  function tombFlames(u, v) {
    const k = tkey(u, v);
    let fs = flameSets.get(k);
    if (fs) return fs;
    const t = tomb(u, v);
    const placed = [];
    for (let i = 0; i < t.depth.length; i++) {
      if (t.depth[i] < 0) continue;
      const bd = boardAt(t, i);
      if (t.routeIndex[i] >= 0) {
        const entry = t.entries.includes(i);
        if (entry || t.routeIndex[i] % 3 === 0) {
          placed.push({ x: bd.x, y: bd.y, cell: flameCell(H, bd.x, bd.y), kind: entry ? 'entry' : 'route' });
        }
      } else if (H('flame', bd.x, bd.y)[0] < 128) {
        placed.push({ x: bd.x, y: bd.y, cell: bd.b, kind: 'dead' });
      }
    }
    const chains = [], gaps = [], added = [];
    t.entries.forEach((_, j) => {
      const span = entrySpan(t, j);
      const chain = [];
      span.forEach((st, pos) => {
        const { bd, down } = st;
        const here = placed.filter((f) => f.kind !== 'dead').concat(added).filter((f) => f.x === bd.x && f.y === bd.y);
        const cells = new Set(here.map((f) => f.cell));
        // The chain ends at the downstream entry's flame, which always burns.
        if (down) cells.add(st.outCell);
        let order = walkOrder(bd, st.inCell, st.outCell, [...cells]);
        if (down) order = order.slice(0, order.indexOf(st.outCell) + 1);
        for (const cell of order) {
          const f = here.find((g) => g.cell === cell);
          chain.push({ x: bd.x, y: bd.y, cell, kind: f ? f.kind : 'entry', pos });
        }
      });
      const split = splitGaps(span, chain);
      added.push(...split.added);
      gaps.push(...split.gaps);
      chains.push(chain);
    });
    fs = { u, v, flames: [...placed, ...added], chains, gaps };
    flameSets.set(k, fs);
    return fs;
  }

  /**
   * Flame cells on board (x, y), ascending: those its tomb places, and on an
   * entry board those the upstream tomb's chains place there.
   */
  function flamesAt(x, y) {
    const p = posOf(x, y);
    let cells = flameCells.get(p);
    if (cells) return cells;
    const { u, v } = tombOf(x, y, size);
    const t = tomb(u, v);
    const i = boardIndex(x, y, size);
    const set = new Set();
    if (t.depth[i] >= 0) {
      const from = [tombFlames(u, v)];
      for (const w of t.walls.slice(1)) if (w.i === i) from.push(tombFlames(u + TDX[w.dir], v + TDY[w.dir]));
      for (const fs of from) for (const f of fs.flames) if (f.x === x && f.y === y) set.add(f.cell);
    }
    cells = [...set].sort((p1, p2) => p1 - p2);
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
   * Where a resumed run starts on board (x, y): its first primary cell. A
   * rock board resumes at its tomb's first entry instead.
   */
  function resumePoint(x, y) {
    let bd = board(x, y);
    if (bd.kind === 'rock') {
      const t = tomb(bd.u, bd.v);
      bd = boardAt(t, t.entries[0]);
    }
    return { board: bd, cell: bd.a };
  }

  /** Where a new run starts: tomb (0, 0)'s first entry. */
  function startPoint() {
    const t = tomb(0, 0);
    const { x, y } = boardCoords(0, 0, t.entries[0], size);
    return resumePoint(x, y);
  }

  /** Drops cached tombs more than one tomb from (u, v) in either axis, and their boards. */
  function retain(u, v) {
    const far = (a, b) => Math.abs(a - u) > 1 || Math.abs(b - v) > 1;
    for (const [k, t] of tombs) if (far(t.u, t.v)) tombs.delete(k);
    for (const [k, fs] of flameSets) if (far(fs.u, fs.v)) flameSets.delete(k);
    for (const [p, bd] of boards) if (far(bd.u, bd.v)) boards.delete(p);
    for (const p of flameCells.keys()) {
      const { x, y } = boardOfPos(p);
      const t = tombOf(x, y, size);
      if (far(t.u, t.v)) flameCells.delete(p);
    }
    flow.retain(u, v, 2);
  }

  return { code, difficulty, size, H, tomb, board, tombFlames, flamesAt, step, resumePoint, startPoint, retain };
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

/**
 * SHA3-256 hex digest over every tomb tree, flame chain and board of tombs
 * u0..u1 by v0..v1, v outer and u inner.
 */
export function digestTombs(world, u0, u1, v0, v1) {
  const parts = [];
  for (let v = v0; v <= v1; v++) {
    for (let u = u0; u <= u1; u++) {
      const t = world.tomb(u, v);
      const w = new Bytes();
      w.i64(u); w.i64(v); w.u8(t.k); w.u8(t.exit); w.u8(t.X);
      w.u8(t.entries.length); w.bytes(t.entries);
      w.u8(t.routes.length);
      for (const r of t.routes) { w.u8(r.length); w.bytes(r); }
      const fs = world.tombFlames(u, v);
      w.u8(fs.chains.length);
      for (const chain of fs.chains) {
        w.u8(chain.length);
        for (const f of chain) { w.i64(f.x); w.i64(f.y); w.u8(f.cell); }
      }
      parts.push(w.done());
      for (let i = 0; i < world.size.w * world.size.h; i++) {
        const { x, y } = boardCoords(u, v, i, world.size);
        parts.push(serializeBoard(world, x, y));
      }
    }
  }
  let n = 0;
  for (const p of parts) n += p.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return toHex(sha3_256(all));
}
