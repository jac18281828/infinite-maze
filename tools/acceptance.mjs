// Spec section 10 acceptance harness. Each check is an exported function over
// a world and a window of tombs and returns { errors, ... }. Continuity,
// Tree, Acyclic, Flames and Solvability derive structure from boards, doors
// and links alone; Flow reads the generator's exits and checks them against
// the doors.
//
// Every check reads the tomb size from its world, and the run checks each
// difficulty over the same window of tombs.
//
//   node tools/acceptance.mjs [--code XXXX-XXXX] [--cols W] [--rows N]
import { pathToFileURL } from 'node:url';
import { sha3_256 } from '../src/world/keccak.mjs';
import { parseCode, toHex, u32 } from '../src/world/hash.mjs';
import {
  createWorld, digestTombs, serializeBoard, acrossDoor, posOf, boardOfPos, boardCoords, boardIndex, tombOf,
} from '../src/world/world.mjs';
import { encodeSave, decodeSave } from '../src/world/save.mjs';

export const SEED = '00000000';
// Digests of tombs u in [-2, 2], v in [0, 19] for seed 0000-0000, per difficulty.
export const DIGESTS = {
  easy: 'ad571179430465c8da3908e5633bb04d5194b60c9f68a10eaa57dbd28f9b71ef',
  medium: 'b0ad6e959d6fbd84a481219019c141e8259edea1c28f1d01dde0d30d3ae4d320',
  hard: 'c8024db96bc44f89b576e1bd535291008958c7ba9acdb15b220ecf48dbf54b01',
};
export const GAP_LIMIT_MS = 150000;
export const GALLERIES_MIN = 4;
export const GALLERIES_MAX = 10;
// Every tree board carves at least CARVE_MIN cells, and the mean per board
// stays within CARVE_MEAN_MIN..CARVE_MEAN_MAX.
export const CARVE_MIN = 50;
export const CARVE_MEAN_MIN = 48;
export const CARVE_MEAN_MAX = 56;
// A run of CEILING_MIN_BOARDS or more boards fails above CEILING_PERCENT
// percent on fallback; shorter runs swing too far to enforce it.
export const CEILING_PERCENT = 2;
export const CEILING_MIN_BOARDS = 2000;

const BW = 12, BH = 7, NCELL = 84;
const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 1, 0, -1, 1, 1, -1, -1];
// Walking time per link in ms over 48 px cells at 96, 48 and 72 px/s.
const LINK_MS = [500, 1000, 500, 1000, 943, 943, 943, 943];
const DIR_NAME = ['right', 'up', 'left', 'down'];
// In-doors list in wall order floor, left, right.
const WALL_ORDER = [3, 2, 0];

function nbCell(c, d) {
  const x = (c % BW) + DX[d], y = ((c / BW) | 0) + DY[d];
  return x < 0 || x >= BW || y < 0 || y >= BH ? -1 : y * BW + x;
}

function hasDoor(bd, dir, cell) {
  return !!bd.links && bd.doors.some((dr) => dr.dir === dir && dr.cell === cell);
}

/** A window of tombs u0..u1 by v0..v1. */
export function tombWindow(u0, u1, v0, v1) {
  return { u0, u1, v0, v1 };
}

function inWindow(win, u, v) {
  return u >= win.u0 && u <= win.u1 && v >= win.v0 && v <= win.v1;
}

/** Tombs of the window as [u, v], v outer. */
function tombsOf(win) {
  const out = [];
  for (let v = win.v0; v <= win.v1; v++) for (let u = win.u0; u <= win.u1; u++) out.push([u, v]);
  return out;
}

function tombBoards(world, u, v) {
  const out = [];
  for (let i = 0; i < world.size.w * world.size.h; i++) {
    const { x, y } = boardCoords(u, v, i, world.size);
    out.push(world.board(x, y));
  }
  return out;
}

function windowBoards(world, win) {
  return tombsOf(win).flatMap(([u, v]) => tombBoards(world, u, v));
}

const tombOfBoard = (world, bd) => tombOf(bd.x, bd.y, world.size);
const indexOf = (world, bd) => boardIndex(bd.x, bd.y, world.size);

/** The board across door `dr` of `bd` when both sides hold the door, else null. */
function throughDoor(world, bd, dr) {
  const nb = world.board(bd.x + DX[dr.dir], bd.y + DY[dr.dir]);
  const nc = acrossDoor(dr.cell, dr.dir);
  return hasDoor(nb, dr.dir ^ 2, nc) ? { board: nb, cell: nc } : null;
}

/** Doors that boards of tomb (u, v) hold on its wall d, as { bd, dr }. */
function wallDoors(world, u, v, d) {
  const out = [];
  const { w, h } = world.size;
  for (let k = 0; k < (d % 2 === 0 ? h : w); k++) {
    const x = d === 0 ? w * u + w - 1 : d === 2 ? w * u : w * u + k;
    const y = d === 1 ? h * v + h - 1 : d === 3 ? h * v : h * v + k;
    const bd = world.board(x, y);
    if (bd.links) for (const dr of bd.doors) if (dr.dir === d) out.push({ bd, dr });
  }
  return out;
}

/**
 * Exit direction of tomb (u, v) from doors alone, or -1. A ceiling door is
 * the exit, since no tomb exits down. Otherwise the exit is a side door:
 * along a row, the tombs joined by side doors hold one ceiling door among
 * them, and every side door leads toward it.
 */
export function doorExit(world, u, v) {
  if (wallDoors(world, u, v, 1).length) return 1;
  const left = wallDoors(world, u, v, 2).length > 0, right = wallDoors(world, u, v, 0).length > 0;
  if (!left || !right) return right ? 0 : left ? 2 : -1;
  for (const d of [2, 0]) {
    for (let cu = u + DX[d], n = 0; n < 100000; cu += DX[d], n++) {
      if (wallDoors(world, cu, v, 1).length) return d;
      if (!wallDoors(world, cu, v, d).length) break;
    }
  }
  return -1;
}

/** Board path from `from` to `to` over `adj`, empty when cut. */
function boardPath(adj, from, to) {
  const prev = new Array(adj.length).fill(-2);
  prev[from] = -1;
  const q = [from];
  for (let h = 0; h < q.length && prev[to] === -2; h++) {
    for (const e of adj[q[h]]) if (prev[e.to] === -2) { prev[e.to] = q[h]; q.push(e.to); }
  }
  const path = [];
  if (prev[to] !== -2) for (let i = to; i >= 0; i = prev[i]) path.unshift(i);
  return path;
}

/**
 * Tomb structure from doors alone: its wall doors, the exit door, the
 * in-doors in wall order and their boards (the entries), the trunk from the
 * first entry to the exit board X, a tributary from each later entry to the
 * first board already in the tree, and each board's distance from a route.
 * A source tomb holds no in-door; its entry board S, which no door marks,
 * is the one value read from the generator.
 */
export function tombShape(world, u, v) {
  const boards = tombBoards(world, u, v);
  const errors = [];
  const adj = boards.map(() => []);
  for (const [i, bd] of boards.entries()) {
    if (!bd.links) continue;
    for (const dr of bd.doors) {
      const t = throughDoor(world, bd, dr);
      if (!t) continue;
      const o = tombOfBoard(world, t.board);
      if (o.u === u && o.v === v) adj[i].push({ to: indexOf(world, t.board), dir: dr.dir, cell: dr.cell });
    }
  }
  const walls = [];
  for (let d = 0; d < 4; d++) for (const { bd, dr } of wallDoors(world, u, v, d)) walls.push({ dir: d, i: indexOf(world, bd), cell: dr.cell });
  const exit = doorExit(world, u, v);
  const out = walls.filter((w) => w.dir === exit);
  if (exit < 0) errors.push(`tomb (${u},${v}): no way on through its doors`);
  else if (out.length !== 1) errors.push(`tomb (${u},${v}): ${out.length} doors on its exit wall`);
  const ins = walls.filter((w) => w.dir !== exit).sort((p, q) => WALL_ORDER.indexOf(p.dir) - WALL_ORDER.indexOf(q.dir));
  const source = ins.length === 0;
  const entries = source ? [world.tomb(u, v).entries[0]] : ins.map((w) => w.i);
  const routeIndex = new Array(boards.length).fill(-1), routeOf = new Array(boards.length).fill(-1);
  const next = new Array(boards.length).fill(-1), depth = new Array(boards.length).fill(-1);
  const routes = [], routeEntry = [];
  const shape = { u, v, boards, adj, walls, exit, exitDoor: out[0], ins, entries, source, routes, routeEntry, routeIndex, routeOf, next, depth, errors };
  if (errors.length) return shape;
  const X = out[0].i;
  const lay = (route, last, entryCell) => {
    route.forEach((i, j) => {
      routeIndex[i] = j; routeOf[i] = routes.length; depth[i] = 0;
      next[i] = j + 1 < route.length ? route[j + 1] : last;
    });
    routes.push(route);
    routeEntry.push(entryCell);
  };
  const trunk = boardPath(adj, entries[0], X);
  if (!trunk.length) { errors.push(`tomb (${u},${v}): no board route from its first entry to its exit`); return shape; }
  lay(trunk, -1, source ? -1 : ins[0].cell);
  for (let j = 1; j < entries.length; j++) {
    if (depth[entries[j]] === 0) continue;
    const path = boardPath(adj, entries[j], X);
    const k = path.findIndex((i) => depth[i] === 0);
    if (k < 0) { errors.push(`tomb (${u},${v}): entry ${j + 1} does not join the tree`); continue; }
    lay(path.slice(0, k), path[k], ins[j].cell);
  }
  const q = boards.map((_, i) => i).filter((i) => depth[i] === 0);
  for (let h = 0; h < q.length; h++) {
    for (const e of adj[q[h]]) if (depth[e.to] < 0) { depth[e.to] = depth[q[h]] + 1; next[e.to] = q[h]; q.push(e.to); }
  }
  return shape;
}

/**
 * Path, junction and branch measures, written apart from the generator.
 * `deficit` is the section 4 deficit: the path's shortfall below 22 cells,
 * the junctions' shortfall below 6 and, for each door-free branch under 3
 * cells, the cells it lacks.
 */
export function measureTargets(links, a, b, doorCells) {
  const dist = new Array(NCELL).fill(-1), parent = new Array(NCELL).fill(-1);
  dist[a] = 0;
  const q = [a];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (let d = 0; d < 8; d++) {
      if (!(links[c] & (1 << d))) continue;
      const t = nbCell(c, d);
      if (dist[t] < 0) { dist[t] = dist[c] + 1; parent[t] = c; q.push(t); }
    }
  }
  if (b < 0) {
    b = a;
    for (let c = 0; c < NCELL; c++) if (dist[c] > dist[b]) b = c;
  }
  const path = [];
  for (let c = b; c >= 0; c = parent[c]) path.push(c);
  const on = new Set(path);
  let junctions = 0, shortBranches = 0, shortfall = 0;
  for (const j of path) {
    let branches = 0;
    for (let d = 0; d < 8; d++) {
      if (!(links[j] & (1 << d))) continue;
      const t = nbCell(j, d);
      if (on.has(t)) continue;
      branches++;
      let deepest = 0, door = false;
      const stack = [[t, 1]], seen = new Set([j, t]);
      while (stack.length) {
        const [c, k] = stack.pop();
        deepest = Math.max(deepest, k);
        if (doorCells.includes(c)) door = true;
        for (let e = 0; e < 8; e++) {
          if (!(links[c] & (1 << e))) continue;
          const u = nbCell(c, e);
          if (!seen.has(u)) { seen.add(u); stack.push([u, k + 1]); }
        }
      }
      if (!door && deepest < 3) { shortBranches++; shortfall += 3 - deepest; }
    }
    if (branches) junctions++;
  }
  const ok = path.length >= 22 && junctions >= 6 && shortBranches === 0;
  const deficit = Math.max(0, 22 - path.length) + Math.max(0, 6 - junctions) + shortfall;
  return { ok, b, pathLen: path.length, junctions, shortBranches, deficit };
}

export function checkKeccak() {
  const vectors = [
    ['', 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a'],
    ['abc', '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '41c0dba2a9d6240849100376a8235e2c82e1b9998a999e21db32dd97496d3376'],
    ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      '916f6061fe879741ca6469b43971dfdb28b1a32dc36cb3254e812be27aad1d18'],
  ];
  const errors = [];
  for (const [msg, want] of vectors) {
    const got = toHex(sha3_256(new TextEncoder().encode(msg)));
    if (got !== want) errors.push(`SHA3-256("${msg.slice(0, 12)}...") = ${got}`);
  }
  const a3 = toHex(sha3_256(new Uint8Array(200).fill(0xa3)));
  if (a3 !== '79f38adec5c20307a98ef76e8324afbfd46cfd81b22e3973c65fa1bd9de31787') errors.push(`SHA3-256(0xA3 x 200) = ${a3}`);
  return { errors, vectors: vectors.length + 1 };
}

/** Every door has a partner at the same row or column across its wall. */
export function checkContinuity(world, win) {
  const errors = [];
  let doors = 0;
  for (const bd of windowBoards(world, win)) {
    if (!bd.links) continue;
    for (const dr of bd.doors) {
      doors++;
      const col = dr.cell % BW, row = (dr.cell / BW) | 0;
      const onWall = [col === BW - 1 && row >= 1 && row <= 5, row === BH - 1 && col >= 1 && col <= 10,
        col === 0 && row >= 1 && row <= 5, row === 0 && col >= 1 && col <= 10][dr.dir];
      if (!onWall) errors.push(`board (${bd.x},${bd.y}): door ${dr.dir} at cell ${dr.cell} is off its wall`);
      if (!throughDoor(world, bd, dr)) {
        errors.push(`board (${bd.x},${bd.y}): door ${dr.dir} at cell ${dr.cell} has no partner`);
      }
    }
  }
  return { errors, doors };
}

/**
 * Errors unless tomb (u, v)'s carved cells and inner doors form one tree
 * (edges = nodes - 1) that joins every door on the tomb's walls, its own
 * and those its neighbours hold toward it. A carved cell holds a link or a
 * door; the rest is rock.
 */
function tombTreeErrors(world, u, v) {
  const errors = [];
  const boards = tombBoards(world, u, v);
  const up = new Int32Array(boards.length * NCELL).map((_, i) => i);
  const carved = (bd, c) => bd.links[c] !== 0 || bd.doors.some((dr) => dr.cell === c);
  const find = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const join = (a, b) => { up[find(a)] = find(b); };
  const inTomb = (bd) => { const o = tombOfBoard(world, bd); return o.u === u && o.v === v; };
  let nodes = 0, edges = 0;
  for (const [i, bd] of boards.entries()) {
    if (!bd.links) continue;
    for (let c = 0; c < NCELL; c++) {
      if (carved(bd, c)) nodes++;
      for (let d = 0; d < 8; d++) {
        if (!(bd.links[c] & (1 << d))) continue;
        const t = nbCell(c, d);
        if (t < 0) { errors.push(`board (${bd.x},${bd.y}): link off the grid at ${c}`); continue; }
        if (!(bd.links[t] & (1 << (d ^ 2)))) errors.push(`board (${bd.x},${bd.y}): one-sided link ${c}->${t}`);
        if (d === 0 || d === 1 || d === 4 || d === 5) { edges++; join(i * NCELL + c, i * NCELL + t); }
      }
    }
    for (const dr of bd.doors) {
      if (dr.dir !== 0 && dr.dir !== 1) continue;
      const t = throughDoor(world, bd, dr);
      if (!t || !inTomb(t.board)) continue;
      edges++;
      join(i * NCELL + dr.cell, indexOf(world, t.board) * NCELL + t.cell);
    }
  }
  const roots = new Set();
  for (const [i, bd] of boards.entries()) {
    if (!bd.links) continue;
    for (let c = 0; c < NCELL; c++) if (carved(bd, c)) roots.add(find(i * NCELL + c));
  }
  if (roots.size !== 1) errors.push(`tomb (${u},${v}): ${roots.size} components`);
  if (edges !== nodes - 1) errors.push(`tomb (${u},${v}): ${edges} edges for ${nodes} nodes`);
  for (let d = 0; d < 4; d++) {
    for (const { bd, dr } of wallDoors(world, u + DX[d], v + DY[d], d ^ 2)) {
      if (!throughDoor(world, bd, dr)) errors.push(`tomb (${u},${v}): the door from board (${bd.x},${bd.y}) is unjoined`);
    }
  }
  return errors;
}

/** Per tomb: cells and doors form one tree joining all of its wall doors. */
export function checkTree(world, win) {
  const errors = [];
  for (const [u, v] of tombsOf(win)) errors.push(...tombTreeErrors(world, u, v));
  return { errors };
}

/**
 * Each tomb exits left, right or up; its exit wall holds exactly one door,
 * matched on both sides; every other wall door faces a neighbour that exits
 * into it; no two side neighbours exit into each other. Reports the shares
 * of up, left and right exits and the mean sideways run: the side exits a
 * way on takes from a window tomb before it exits up.
 */
export function checkFlow(world, win) {
  const errors = [];
  const counts = [0, 0, 0, 0];
  let runs = 0, tombs = 0;
  const exitOf = (u, v) => world.tomb(u, v).exit;
  for (const [u, v] of tombsOf(win)) {
    tombs++;
    const e = exitOf(u, v);
    counts[e] = (counts[e] || 0) + 1;
    if (e !== 0 && e !== 1 && e !== 2) errors.push(`tomb (${u},${v}): exits ${DIR_NAME[e] ?? e}`);
    for (let d = 0; d < 4; d++) {
      const doors = wallDoors(world, u, v, d);
      if (d === e) {
        if (doors.length !== 1) errors.push(`tomb (${u},${v}): ${doors.length} doors on its exit wall`);
        else if (!throughDoor(world, doors[0].bd, doors[0].dr)) errors.push(`tomb (${u},${v}): its exit door has no partner`);
        continue;
      }
      if (doors.length && exitOf(u + DX[d], v + DY[d]) !== (d ^ 2)) {
        errors.push(`tomb (${u},${v}): a door on its ${DIR_NAME[d]} wall faces a tomb that does not exit into it`);
      }
    }
    if (e === 0 && exitOf(u + 1, v) === 2) errors.push(`tombs (${u},${v}) and (${u + 1},${v}) exit into each other`);
    for (let cu = u, n = 0; n < 1000; n++) {
      const d = exitOf(cu, v);
      if (d !== 0 && d !== 2) break;
      runs++;
      cu += DX[d];
    }
  }
  const share = (n) => (tombs ? n / tombs : 0);
  return { errors, tombs, up: share(counts[1]), left: share(counts[2]), right: share(counts[0]), meanRun: tombs ? runs / tombs : 0 };
}

/** The window's tombs, joined by the doors held on both sides of their walls, form a forest. */
export function checkAcyclic(world, win) {
  const errors = [];
  const up = new Map();
  const find = (k) => { while (up.has(k) && up.get(k) !== k) k = up.get(k); return k; };
  let doors = 0;
  for (const [u, v] of tombsOf(win)) {
    for (const d of [0, 1]) {
      const nu = u + DX[d], nv = v + DY[d];
      if (!inWindow(win, nu, nv)) continue;
      for (const { bd, dr } of wallDoors(world, u, v, d)) {
        if (!throughDoor(world, bd, dr)) continue;
        doors++;
        const a = find(`${u},${v}`), b = find(`${nu},${nv}`);
        if (a === b) errors.push(`tombs (${u},${v}) and (${nu},${nv}): a door closes a cycle`);
        else up.set(a, b);
      }
    }
  }
  return { errors, doors };
}

const flameCellOf = (world, bd) => u32(world.H('flame', bd.x, bd.y), 4) % NCELL;

/**
 * Primary pair of board i in tomb shape s: a route board joins the door it
 * enters its route by (its in-door, or the flame cell on S) to the door it
 * leads on by (the exit door on X); a dead end pairs its parent door with
 * -1 (deepest).
 */
function primaryPair(world, s, i, bd) {
  const doorTo = (j) => s.adj[i].find((e) => e.to === j)?.cell;
  const r = s.routeIndex[i];
  if (r < 0) return [doorTo(s.next[i]), -1];
  const route = s.routes[s.routeOf[i]];
  let a = r > 0 ? doorTo(route[r - 1]) : s.routeEntry[s.routeOf[i]];
  if (a < 0) a = flameCellOf(world, bd);
  const b = s.next[i] >= 0 ? doorTo(s.next[i]) : i === s.exitDoor.i ? s.exitDoor.cell : -1;
  return [a, b];
}

/**
 * The trunk holds at least half the tomb's boards, a one-board trunk aside;
 * dead ends reach at most 2 boards; boards meet section 4 or flag fallback;
 * a run of `minBoards` boards or more keeps fallbacks at or under 2%.
 * Reports trunk lengths and rock boards.
 */
export function checkBounds(world, win, minBoards = CEILING_MIN_BOARDS) {
  const errors = [], tombs = [];
  let boards = 0, fallbacks = 0;
  for (const [u, v] of tombsOf(win)) {
    const s = tombShape(world, u, v);
    errors.push(...s.errors);
    if (s.errors.length) continue;
    errors.push(...trunkErrors(world, s));
    tombs.push({ route: s.routes[0].length, rock: s.boards.filter((bd) => !bd.links).length });
    s.boards.forEach((bd, i) => {
      if (!bd.links) return;
      boards++;
      if (bd.fallback) fallbacks++;
      if (s.depth[i] < 0) { errors.push(`board (${bd.x},${bd.y}): cut off from the routes`); return; }
      if (s.depth[i] > 2) errors.push(`board (${bd.x},${bd.y}): dead-end branch ${s.depth[i]} boards deep`);
      const [a, c] = primaryPair(world, s, i, bd);
      const m = measureTargets(bd.links, a, c, bd.doors.map((d) => d.cell));
      if (!m.ok && !bd.fallback) {
        errors.push(`board (${bd.x},${bd.y}): misses targets (path ${m.pathLen}, junctions ${m.junctions}, short ${m.shortBranches}) without fallback`);
      }
    });
  }
  if (boards >= minBoards && 100 * fallbacks > CEILING_PERCENT * boards) {
    errors.push(`${fallbacks} of ${boards} boards (${(100 * fallbacks / boards).toFixed(1)}%) fall back, over the ${CEILING_PERCENT}% ceiling`);
  }
  return { errors, boards, fallbacks, ...tombFigures(tombs) };
}

/**
 * An error unless tomb shape s's trunk holds at least half the tomb's
 * boards. A trunk of the one board X is exempt: its first entry is X.
 */
function trunkErrors(world, s) {
  const n = world.size.w * world.size.h, len = s.routes[0].length;
  return len > 1 && 2 * len < n ? [`tomb (${s.u},${s.v}): trunk of ${len} boards holds under half of ${n}`] : [];
}

/** Shortest and mean trunk, and mean rock boards, over tombs of { route, rock }. */
function tombFigures(tombs) {
  const mean = (key) => (tombs.length ? tombs.reduce((sum, t) => sum + t[key], 0) / tombs.length : 0);
  return { routeMin: Math.min(...tombs.map((t) => t.route)), routeMean: mean('route'), rockMean: mean('rock') };
}

/**
 * Every gallery owns its 2x2 block: no other link joins two of its cells and
 * no cell lies in two blocks. Galleries average 4-10 per board.
 */
export function checkGalleries(world, win) {
  const errors = [];
  let boards = 0, galleries = 0, conflicts = 0;
  for (const bd of windowBoards(world, win)) {
    if (!bd.links) continue;
    boards++;
    const owner = new Array(NCELL).fill(-1);
    for (let c = 0; c < NCELL; c++) {
      for (const d of [4, 5]) {
        if (!(bd.links[c] & (1 << d))) continue;
        galleries++;
        const x0 = (c % BW) - (d === 5 ? 1 : 0), a = ((c / BW) | 0) * BW + x0;
        const block = [a, a + 1, a + BW, a + BW + 1];
        // Each in-block link counts once from each end; the gallery is one.
        let ends = 0;
        for (const u of block) {
          for (let e = 0; e < 8; e++) if (bd.links[u] & (1 << e) && block.includes(nbCell(u, e))) ends++;
        }
        const shared = ends > 2, overlap = block.some((u) => owner[u] >= 0);
        for (const u of block) owner[u] = c;
        if (!shared && !overlap) continue;
        conflicts++;
        errors.push(`board (${bd.x},${bd.y}): gallery ${c} dir ${d} ${shared ? 'shares its block with another link' : 'overlaps another block'}`);
      }
    }
  }
  const mean = boards ? galleries / boards : 0;
  if (mean < GALLERIES_MIN || mean > GALLERIES_MAX) {
    errors.push(`galleries per board average ${mean.toFixed(2)}, outside ${GALLERIES_MIN}-${GALLERIES_MAX}`);
  }
  return { errors, boards, galleries, conflicts, mean };
}

/**
 * Doors and flames sit on carved cells, every tree board carves at least 50
 * cells and the mean stays within 48-56. A cell is carved when it holds a
 * link, doors aside.
 */
export function checkCarve(world, win) {
  const errors = [];
  let boards = 0, carved = 0;
  for (const bd of windowBoards(world, win)) {
    if (!bd.links) continue;
    boards++;
    let n = 0;
    for (let c = 0; c < NCELL; c++) if (bd.links[c]) n++;
    carved += n;
    if (n < CARVE_MIN) errors.push(`board (${bd.x},${bd.y}): ${n} carved cells, under ${CARVE_MIN}`);
    for (const dr of bd.doors) {
      if (!bd.links[dr.cell]) errors.push(`board (${bd.x},${bd.y}): door cell ${dr.cell} is pruned`);
    }
    for (const c of world.flamesAt(bd.x, bd.y)) {
      if (!bd.links[c]) errors.push(`board (${bd.x},${bd.y}): flame cell ${c} is pruned`);
    }
  }
  const mean = boards ? carved / boards : 0;
  if (mean < CARVE_MEAN_MIN || mean > CARVE_MEAN_MAX) {
    errors.push(`carved cells per board average ${mean.toFixed(2)}, outside ${CARVE_MEAN_MIN}-${CARVE_MEAN_MAX}`);
  }
  return { errors, boards, mean };
}

/** Walking time in ms from cell A to cell B through the cell graph of `boards`. */
export function walkMs(world, boards, A, B) {
  const slot = new Map(boards.map((bd, i) => [bd.p, i]));
  const ms = new Float64Array(boards.length * NCELL).fill(-1);
  const sA = slot.get(posOf(A.x, A.y)), sB = slot.get(posOf(B.x, B.y));
  if (sA === undefined || sB === undefined) return Infinity;
  const start = sA * NCELL + A.cell, goal = sB * NCELL + B.cell;
  ms[start] = 0;
  const q = [start];
  for (let h = 0; h < q.length && ms[goal] < 0; h++) {
    const id = q[h], bd = boards[(id / NCELL) | 0], c = id % NCELL;
    for (let d = 0; d < 8; d++) {
      if (!(bd.links[c] & (1 << d))) continue;
      const t = ((id / NCELL) | 0) * NCELL + nbCell(c, d);
      if (ms[t] < 0) { ms[t] = ms[id] + LINK_MS[d]; q.push(t); }
    }
    for (const dr of bd.doors) {
      if (dr.cell !== c) continue;
      const t = throughDoor(world, bd, dr);
      if (!t || !slot.has(t.board.p)) continue;
      const tid = slot.get(t.board.p) * NCELL + t.cell;
      if (ms[tid] < 0) { ms[tid] = ms[id] + LINK_MS[dr.dir]; q.push(tid); }
    }
  }
  return ms[goal] < 0 ? Infinity : ms[goal];
}

const sameFlame = (f, g) => f.x === g.x && f.y === g.y && f.cell === g.cell;

/**
 * Boards of entry j's way on in tomb shape s: the board path from the entry
 * to X, then the board across the exit door. Empty when cut.
 */
export function entrySpan(world, s, j) {
  const path = boardPath(s.adj, s.entries[j], s.exitDoor.i);
  if (!path.length) return [];
  const X = s.boards[s.exitDoor.i];
  const across = throughDoor(world, X, { dir: s.exit, cell: s.exitDoor.cell });
  return across ? [...path.map((i) => s.boards[i]), across.board] : [];
}

/**
 * Chain faults of entry j: wrong ends, flames off the way on or out of
 * order, and unlit chain flames.
 */
function chainErrors(world, s, j, chain, span) {
  const errors = [];
  const at = `tomb (${s.u},${s.v}) entry ${j + 1}`;
  const entry = span[0], down = span[span.length - 1];
  if (!chain.length || chain[0].x !== entry.x || chain[0].y !== entry.y) errors.push(`${at}: chain does not start on the entry board`);
  const end = chain[chain.length - 1];
  if (!end || end.x !== down.x || end.y !== down.y) errors.push(`${at}: chain does not end on the downstream entry board`);
  let last = 0;
  for (const f of chain) {
    const o = span.findIndex((bd) => bd.x === f.x && bd.y === f.y);
    if (o < 0) errors.push(`${at}: chain flame on board (${f.x},${f.y}) is off the way on`);
    else if (o < last) errors.push(`${at}: chain runs backwards at board (${f.x},${f.y})`);
    else last = o;
    if (!world.flamesAt(f.x, f.y).includes(f.cell)) errors.push(`${at}: chain flame (${f.x},${f.y}):${f.cell} is not lit`);
  }
  return errors;
}

/**
 * Entries hold flames; along each entry's way on, consecutive chain flames
 * lie <= 150 s apart; every flame on a route board belongs to a chain.
 */
export function checkFlames(world, win) {
  const errors = [];
  const gaps = [];
  for (const [u, v] of tombsOf(win)) {
    const s = tombShape(world, u, v);
    errors.push(...s.errors);
    if (s.errors.length) continue;
    const fs = world.tombFlames(u, v);
    if (fs.chains.length !== s.entries.length) errors.push(`tomb (${u},${v}): ${fs.chains.length} chains for ${s.entries.length} entries`);
    for (const i of s.entries) {
      const bd = s.boards[i];
      if (world.flamesAt(bd.x, bd.y).length === 0) errors.push(`tomb (${u},${v}): entry board (${bd.x},${bd.y}) holds no flame`);
    }
    fs.chains.forEach((chain, j) => {
      if (j >= s.entries.length) return;
      const span = entrySpan(world, s, j);
      if (!span.length) { errors.push(`tomb (${u},${v}) entry ${j + 1}: no way on through doors`); return; }
      errors.push(...chainErrors(world, s, j, chain, span));
      for (let i = 0; i + 1 < chain.length; i++) {
        const t = walkMs(world, span, chain[i], chain[i + 1]);
        gaps.push(t);
        if (t > GAP_LIMIT_MS) errors.push(`tomb (${u},${v}) entry ${j + 1}: flame gap ${(t / 1000).toFixed(1)} s exceeds 150 s`);
      }
    });
    // Upstream chains end on this tomb's entry boards.
    const upstream = s.ins.map((w) => ({ i: w.i, chains: world.tombFlames(u + DX[w.dir], v + DY[w.dir]).chains }));
    s.boards.forEach((bd, i) => {
      if (s.routeIndex[i] < 0) return;
      for (const cell of world.flamesAt(bd.x, bd.y)) {
        const f = { x: bd.x, y: bd.y, cell };
        const known = fs.chains.some((c) => c.some((g) => sameFlame(f, g)))
          || upstream.some((w) => w.i === i && w.chains.some((c) => c.some((g) => sameFlame(f, g))));
        if (!known) errors.push(`tomb (${u},${v}): route flame (${bd.x},${bd.y}):${cell} is missing from every chain`);
      }
    });
  }
  return { errors, gaps };
}

/**
 * Follows the generator's exits from tomb (u, v0) until a tomb in row v1,
 * leaving the window sideways if the walk does; a BFS over cells and doors,
 * confined to those tombs, reaches the last tomb's exit door from the first
 * tomb's first entry.
 */
export function checkSolvability(world, win, u = 0) {
  const walk = [[u, win.v0]];
  for (let n = 0; walk[walk.length - 1][1] < win.v1 && n < 1000000; n++) {
    const [cu, cv] = walk[walk.length - 1];
    const d = world.tomb(cu, cv).exit;
    if (d !== 0 && d !== 1 && d !== 2) return { errors: [`tomb (${cu},${cv}) has no way on up`], cells: 0, tombs: walk.length };
    walk.push([cu + DX[d], cv + DY[d]]);
  }
  const keys = new Set(walk.map(([a, b]) => `${a},${b}`));
  const s0 = tombShape(world, ...walk[0]), s1 = tombShape(world, ...walk[walk.length - 1]);
  if (s0.errors.length || s1.errors.length) return { errors: [...s0.errors, ...s1.errors], cells: 0, tombs: walk.length };
  const first = s0.boards[s0.entries[0]], last = s1.boards[s1.exitDoor.i];
  const startCell = s0.source ? flameCellOf(world, first) : s0.ins[0].cell;
  const goalCell = s1.exitDoor.cell;
  const seen = new Map();
  const mark = (p, c) => {
    let m = seen.get(p);
    if (!m) { m = new Uint8Array(NCELL); seen.set(p, m); }
    if (m[c]) return false;
    m[c] = 1;
    return true;
  };
  const q = [[first, startCell]];
  mark(first.p, startCell);
  let reached = false, cells = 0;
  for (let h = 0; h < q.length; h++) {
    const [bd, c] = q[h];
    cells++;
    if (bd.p === last.p && c === goalCell) { reached = true; break; }
    for (let d = 0; d < 8; d++) {
      if (!(bd.links[c] & (1 << d))) continue;
      const t = nbCell(c, d);
      if (mark(bd.p, t)) q.push([bd, t]);
    }
    for (const dr of bd.doors) {
      if (dr.cell !== c) continue;
      const t = throughDoor(world, bd, dr);
      if (!t) continue;
      const o = tombOfBoard(world, t.board);
      if (!keys.has(`${o.u},${o.v}`)) continue;
      if (mark(t.board.p, t.cell)) q.push([t.board, t.cell]);
    }
  }
  const [lu, lv] = walk[walk.length - 1];
  return {
    errors: reached ? [] : [`tomb (${lu},${lv})'s exit is unreachable from tomb (${u},${win.v0})'s first entry`],
    cells, tombs: walk.length,
  };
}

/**
 * Saves round-trip, and a board resumed at the world's difficulty matches
 * one generated in sequence.
 */
export function checkSaves(world, positions) {
  const errors = [];
  const fresh = createWorld(world.code, { difficulty: world.difficulty });
  for (const p of positions) {
    const { x, y } = boardOfPos(p);
    const text = encodeSave(world.code, x, y);
    const back = decodeSave(text);
    if (!back || back.code !== world.code || back.p !== p || back.x !== x || back.y !== y) {
      errors.push(`save ${text} does not round-trip`);
    }
    const a = serializeBoard(world, x, y), b = serializeBoard(fresh, x, y);
    if (a.length !== b.length || a.some((val, i) => val !== b[i])) errors.push(`board at p=${p} differs when resumed`);
  }
  return { errors, saves: positions.length };
}

/**
 * A fixed seed code yields the pinned digest of tombs u in [-2, 2], v in
 * [0, 19] at a difficulty.
 */
export function checkDeterminism(code = SEED, want = DIGESTS.hard, difficulty = 'hard') {
  const got = digestTombs(createWorld(code, { difficulty }), -2, 2, 0, 19);
  return { errors: got === want ? [] : [`digest of tombs [-2, 2] x [0, 19] is ${got}, pinned ${want}`], digest: got };
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** The first entry board and one other board of tombs sampled across the window, signs mixed. */
function saveSamples(world, win) {
  const samples = [];
  const du = Math.max(1, Math.floor((win.u1 - win.u0) / 2)), dv = Math.max(1, Math.floor((win.v1 - win.v0) / 6));
  for (let v = win.v0; v <= win.v1; v += dv) {
    for (let u = win.u0; u <= win.u1; u += du) {
      const n = world.size.w * world.size.h;
      const { x, y } = boardCoords(u, v, world.tomb(u, v).entries[0], world.size);
      const o = boardCoords(u, v, (((u * 7 + v * 5) % n) + n) % n, world.size);
      samples.push(posOf(x, y), posOf(o.x, o.y));
    }
  }
  return samples;
}

/** Runs every world check; returns [name, result, detail] rows and summary figures. */
export function runChecks(world, code, win) {
  const rows = [];
  const flames = checkFlames(world, win);
  const gaps = flames.gaps.slice().sort((p, q) => p - q);
  const gapText = `max ${(gaps.at(-1) / 1000).toFixed(1)} s, p99 ${(percentile(gaps, 0.99) / 1000).toFixed(1)} s`;
  const c = checkContinuity(world, win);
  rows.push(['continuity', c, `${c.doors} doors`]);
  rows.push(['tree', checkTree(world, win), 'edges = nodes - 1 per tomb, every wall door joined']);
  const flow = checkFlow(world, win);
  const pct = (f) => `${(100 * f).toFixed(1)}%`;
  const flowText = `up ${pct(flow.up)}, left ${pct(flow.left)}, right ${pct(flow.right)}; mean sideways run ${flow.meanRun.toFixed(2)}`;
  rows.push(['flow', flow, flowText]);
  const acyclic = checkAcyclic(world, win);
  rows.push(['acyclic', acyclic, `${acyclic.doors} tomb doors, no cycle`]);
  const bounds = checkBounds(world, win);
  rows.push(['bounds', bounds, `${bounds.boards} boards, ${bounds.fallbacks} on best-attempt fallback`]);
  const galleries = checkGalleries(world, win);
  rows.push(['galleries', galleries, `${galleries.mean.toFixed(2)} per board, ${galleries.conflicts} block conflicts`]);
  const carve = checkCarve(world, win);
  rows.push(['carve', carve, `${carve.mean.toFixed(1)} carved cells per board`]);
  rows.push(['flames', flames, `${gaps.length} gaps, ${gapText}`]);
  const solve = checkSolvability(world, win);
  rows.push(['solvability', solve, `${solve.tombs} tombs, ${solve.cells} cells searched`]);
  const saves = checkSaves(world, saveSamples(world, win));
  rows.push(['saves', saves, `${saves.saves} positions`]);
  const d = world.difficulty;
  const det = code === SEED
    ? checkDeterminism(SEED, DIGESTS[d], d)
    : { errors: [], digest: digestTombs(createWorld(code, { difficulty: d }), -2, 2, 0, 19) };
  rows.push(['determinism', det, `tombs [-2, 2] x [0, 19] digest ${det.digest.slice(0, 16)}...`]);
  return { rows, bounds, galleries, carve, gapText, flowText, digest: det.digest };
}

function printRows(rows, tag) {
  let failed = 0;
  for (const [name, r, detail] of rows) {
    const ok = r.errors.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${tag.padEnd(7)}${name.padEnd(12)} ${detail}`);
    for (const e of r.errors.slice(0, 10)) console.log(`      ${e}`);
    if (r.errors.length > 10) console.log(`      ... ${r.errors.length - 10} more`);
  }
  return failed;
}

/** One difficulty's figures: tomb size, window, trunks, rock, fallbacks, galleries, carve, gaps, flow and digest. */
function printSummary({ difficulty, size, win, bounds, galleries, carve, gapText, flowText, digest }, code) {
  const tombs = (win.u1 - win.u0 + 1) * (win.v1 - win.v0 + 1);
  console.log('');
  console.log(`${difficulty.toUpperCase()}: tombs of ${size.w}x${size.h} = ${size.w * size.h} rooms`);
  console.log(`tombs checked:  u ${win.u0}..${win.u1}, v ${win.v0}..${win.v1} (${tombs}) for seed ${code.slice(0, 4)}-${code.slice(4)}`);
  console.log(`trunk:          mean ${bounds.routeMean.toFixed(2)}, min ${bounds.routeMin} rooms (half the tomb: ${(size.w * size.h) >> 1})`);
  console.log(`rock rooms:     ${bounds.rockMean.toFixed(2)} per tomb`);
  console.log(`fallback boards: ${bounds.fallbacks} of ${bounds.boards} (${(100 * bounds.fallbacks / bounds.boards).toFixed(1)}%)`);
  console.log(`galleries:      ${galleries.mean.toFixed(2)} per board`);
  console.log(`block conflicts: ${galleries.conflicts}`);
  console.log(`carved cells:   ${carve.mean.toFixed(1)} per board (${(100 * carve.mean / NCELL).toFixed(0)}% of ${NCELL})`);
  console.log(`flame gap:      ${gapText}`);
  console.log(`flow:           ${flowText}`);
  console.log(`digest:         ${digest}`);
}

async function main(argv) {
  const t0 = performance.now();
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const code = parseCode(arg('--code', SEED));
  const W = Number(arg('--cols', 10)), N = Number(arg('--rows', 50));
  if (!code || !Number.isInteger(W) || W < 0 || !Number.isInteger(N) || N < 1) {
    console.error('usage: acceptance.mjs [--code XXXX-XXXX] [--cols W] [--rows N]');
    return 2;
  }
  const win = tombWindow(-W, W, -N, N);
  const k = checkKeccak();
  let failed = printRows([['keccak', k, `${k.vectors} FIPS 202 vectors`]], '');
  const summaries = [];
  for (const difficulty of ['hard', 'easy', 'medium']) {
    const world = createWorld(code, { difficulty });
    const r = runChecks(world, code, win);
    failed += printRows(r.rows, difficulty.toUpperCase());
    summaries.push({ difficulty, size: world.size, win, ...r });
  }
  for (const summary of summaries) printSummary(summary, code);
  console.log('');
  console.log(`run time:       ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  console.log(failed ? `FAILED: ${failed} check(s)` : 'ALL CHECKS PASS');
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
