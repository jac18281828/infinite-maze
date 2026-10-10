// Spec section 10 and docs/ROUTE.md section 9 acceptance harness. Each check
// is an exported function over a world and returns { errors, ... }. The route
// checks derive structure from boards, doors and links alone: they walk the
// route through doors held on both sides, taking only band (0, 0)'s entry and
// exit walls from the generator. Balance and Start chain read the generator.
//
//   node tools/acceptance.mjs [--code XXXX-XXXX] [--bands N]
//
// --bands N checks route indices -N..N.
import { pathToFileURL } from 'node:url';
import { sha3_256 } from '../src/world/keccak.mjs';
import { parseCode, toHex, u32 } from '../src/world/hash.mjs';
import {
  createWorld, digestBands, serializeBoard, acrossDoor, posOf, boardCoords, boardIndex, routeBands,
} from '../src/world/world.mjs';
import { encodeSave, decodeSave } from '../src/world/save.mjs';

export const SEED = '00000000';
export const DIGEST_0_99 = 'fa03489590d49a1c64f06086375de71275df12002662c049dfa3991b55606953';
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
// Each direction carries this share of moves, in percent, over BALANCE_BANDS route bands.
export const BALANCE_MIN = 20;
export const BALANCE_MAX = 30;
export const BALANCE_BANDS = 10000;
export const START_LEVELS = 20;

const BW = 12, BH = 7, NCELL = 84, BANDW = 6, BANDH = 4;
const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 1, 0, -1, 1, 1, -1, -1];
// Walking time per link in ms over 48 px cells at 96, 48 and 72 px/s.
const LINK_MS = [500, 1000, 500, 1000, 943, 943, 943, 943];
// Route walls L R D U: their board directions, steps and names.
const WALL_DIR = [2, 0, 3, 1];
const WALL_OF_DIR = [1, 3, 0, 2];
const WX = [-1, 1, 0, 0], WY = [0, 0, -1, 1];
const WALL_NAME = 'LRDU';

function nbCell(c, d) {
  const x = (c % BW) + DX[d], y = ((c / BW) | 0) + DY[d];
  return x < 0 || x >= BW || y < 0 || y >= BH ? -1 : y * BW + x;
}

function hasDoor(bd, dir, cell) {
  return !!bd.links && bd.doors.some((dr) => dr.dir === dir && dr.cell === cell);
}

const bandKey = (u, v) => `${u},${v}`;
const boardKey = (bd) => `${bd.x},${bd.y}`;
const bandName = (b) => `band (${b.u},${b.v})`;

function inBand(x, y, u, v) {
  return Math.floor(x / BANDW) === u && Math.floor(y / BANDH) === v;
}

function bandBoards(world, u, v) {
  const out = [];
  for (let i = 0; i < BANDW * BANDH; i++) {
    const { x, y } = boardCoords(u, v, i);
    out.push(world.board(x, y));
  }
  return out;
}

/** The board across wall d of `bd` when both sides hold the door, else null. */
function throughDoor(world, bd, dr) {
  const nb = world.board(bd.x + DX[dr.dir], bd.y + DY[dr.dir]);
  const nc = acrossDoor(dr.cell, dr.dir);
  return hasDoor(nb, dr.dir ^ 2, nc) ? { board: nb, cell: nc } : null;
}

/** Doors of band (u, v) that cross its boundary and are held on both sides. */
function boundaryDoors(world, u, v) {
  const out = [];
  for (const bd of bandBoards(world, u, v)) {
    if (!bd.links) continue;
    for (const dr of bd.doors) {
      if (inBand(bd.x + DX[dr.dir], bd.y + DY[dr.dir], u, v)) continue;
      const to = throughDoor(world, bd, dr);
      if (to) out.push({ board: bd, cell: dr.cell, dir: dr.dir, to });
    }
  }
  return out;
}

const sameDoor = (d, board, cell, dir) => d.board.x === board.x && d.board.y === board.y && d.cell === cell && d.dir === dir;

/**
 * The route from doors alone, route indices i0..i1, walked from band (0, 0).
 * Band (0, 0)'s entry and exit are its boundary doors on the generator's
 * entry and exit walls. Each further band is entered through the door it
 * shares with the band before it and left through the one other boundary
 * door held on both sides. A band where that fails ends the walk in its
 * direction. `bands` holds the walked bands of i0..i1, each { u, v, index,
 * entry, exit, doors }, entry and exit being boundary doors or null.
 */
export function walkRoute(world, i0, i1) {
  const errors = [];
  const seen = new Map();
  const t = world.tree(0, 0);
  const doors0 = boundaryDoors(world, 0, 0);
  const onWall = (w) => doors0.filter((d) => d.dir === WALL_DIR[w]);
  const ins = t.rock ? [] : onWall(t.entryWall), outs = t.rock ? [] : onWall(t.exitWall);
  if (t.rock || doors0.length !== 2 || ins.length !== 1 || outs.length !== 1) {
    errors.push(`route band 0, band (0,0): ${doors0.length} boundary doors, ${ins.length} on its entry wall and ${outs.length} on its exit wall`);
  }
  const start = { u: 0, v: 0, index: 0, entry: ins.length === 1 ? ins[0] : null, exit: outs.length === 1 ? outs[0] : null, doors: doors0 };
  seen.set(bandKey(0, 0), 0);
  const walk = (dir, last) => {
    const out = [];
    let cur = start;
    for (let i = dir; dir > 0 ? i <= last : i >= last; i += dir) {
      const leave = dir > 0 ? cur.exit : cur.entry;
      if (!leave) break;
      const { board } = leave.to;
      const u = Math.floor(board.x / BANDW), v = Math.floor(board.y / BANDH);
      const doors = boundaryDoors(world, u, v);
      const back = doors.find((d) => sameDoor(d, board, leave.to.cell, leave.dir ^ 2));
      const others = doors.filter((d) => d !== back);
      const onward = others.length === 1 ? others[0] : null;
      const rec = { u, v, index: i, entry: dir > 0 ? back : onward, exit: dir > 0 ? onward : back, doors };
      if (Math.abs(u - cur.u) + Math.abs(v - cur.v) !== 1) errors.push(`route band ${i}, ${bandName(rec)}: not adjacent to ${bandName(cur)}`);
      const k = bandKey(u, v);
      if (seen.has(k)) {
        errors.push(`route band ${i}, ${bandName(rec)}: visited again, first as route band ${seen.get(k)}`);
        break;
      }
      seen.set(k, i);
      out.push(rec);
      if (!onward) {
        errors.push(`route band ${i}, ${bandName(rec)}: cannot leave through exactly one other boundary door (${others.length})`);
        break;
      }
      cur = rec;
    }
    return out;
  };
  const after = walk(1, Math.max(i1, 0)), before = walk(-1, Math.min(i0, 0));
  const all = [...before.reverse(), start, ...after];
  const byIndex = new Map(all.map((b) => [b.index, b]));
  return {
    bands: all.filter((b) => b.index >= i0 && b.index <= i1), errors,
    at: (i) => byIndex.get(i) ?? null, complete: byIndex.has(i0) && byIndex.has(i1),
  };
}

/** Board adjacency of band (u, v) through internal doors held on both sides. */
function boardGraph(world, boards, u, v) {
  const adj = boards.map(() => []);
  for (const bd of boards) {
    if (!bd.links) continue;
    for (const dr of bd.doors) {
      if (!inBand(bd.x + DX[dr.dir], bd.y + DY[dr.dir], u, v)) continue;
      const t = throughDoor(world, bd, dr);
      if (t) adj[boardIndex(bd.x, bd.y)].push({ to: boardIndex(t.board.x, t.board.y), dir: dr.dir, cell: dr.cell });
    }
  }
  return adj;
}

/** Board path from `from` to `to` (empty when cut) and each board's distance from it. */
function routeAndDepth(adj, from, to) {
  const prev = new Array(adj.length).fill(-2);
  prev[from] = -1;
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    for (const e of adj[q[h]]) if (prev[e.to] === -2) { prev[e.to] = q[h]; q.push(e.to); }
  }
  const route = [];
  if (prev[to] !== -2) for (let i = to; i >= 0; i = prev[i]) route.unshift(i);
  const depth = new Array(adj.length).fill(-1);
  for (const i of route) depth[i] = 0;
  const q2 = [...route];
  for (let h = 0; h < q2.length; h++) {
    for (const e of adj[q2[h]]) if (depth[e.to] < 0) { depth[e.to] = depth[q2[h]] + 1; q2.push(e.to); }
  }
  return { route, depth };
}

/**
 * Band structure from doors alone, for a band `rb` of walkRoute: its entry
 * and exit doors, the board route between them and each board's distance
 * from that route.
 */
export function bandShape(world, rb) {
  const boards = bandBoards(world, rb.u, rb.v);
  const adj = boardGraph(world, boards, rb.u, rb.v);
  const errors = [];
  let route = [], depth = new Array(boards.length).fill(-1);
  if (!rb.entry || !rb.exit) errors.push(`${bandName(rb)}: the walk finds no ${rb.entry ? 'exit' : 'entry'} door`);
  else {
    ({ route, depth } = routeAndDepth(adj, boardIndex(rb.entry.board.x, rb.entry.board.y), boardIndex(rb.exit.board.x, rb.exit.board.y)));
    if (!route.length) errors.push(`${bandName(rb)}: no board route from entry to exit`);
  }
  return { u: rb.u, v: rb.v, boards, adj, route, depth, entry: rb.entry, exit: rb.exit, errors };
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

/** Route indices i0..i1 visit no band twice, and each step moves to an adjacent band. */
export function checkSimpleRoute(world, i0, i1) {
  const walk = walkRoute(world, i0, i1);
  const errors = [...walk.errors];
  if (!walk.complete && !errors.length) errors.push(`the walk covers ${walk.bands.length} of ${i1 - i0 + 1} route bands`);
  return { errors, bands: walk.bands.length };
}

/** Every band the walk reaches enters and leaves through different walls: no two of its boundary doors share one. */
export function checkWalls(world, i0, i1) {
  const errors = [];
  for (const rb of walkRoute(world, i0, i1).bands) {
    const count = [0, 0, 0, 0];
    for (const d of rb.doors) count[WALL_OF_DIR[d.dir]]++;
    count.forEach((n, w) => {
      if (n > 1) errors.push(`${bandName(rb)}: ${n} boundary doors share wall ${WALL_NAME[w]}`);
    });
  }
  return { errors };
}

/** Every door has a partner at the same row or column across its wall. */
export function checkContinuity(world, i0, i1) {
  const errors = [];
  let doors = 0;
  for (const rb of walkRoute(world, i0, i1).bands) {
    for (const bd of bandBoards(world, rb.u, rb.v)) {
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
  }
  return { errors, doors };
}

/**
 * Errors when band (u, v)'s carved cells and doors are not one tree (edges =
 * nodes - 1). A carved cell holds a link or a door; the rest is rock.
 */
function bandTreeErrors(world, u, v) {
  const errors = [];
  const boards = bandBoards(world, u, v);
  const slot = new Map();
  boards.forEach((bd, i) => { if (bd.links) slot.set(boardKey(bd), i); });
  const up = new Int32Array(boards.length * NCELL).map((_, i) => i);
  const carved = (bd, c) => bd.links[c] !== 0 || bd.doors.some((dr) => dr.cell === c);
  const find = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const join = (a, b) => { up[find(a)] = find(b); };
  let nodes = 0, edges = 0;
  for (const i of slot.values()) {
    const bd = boards[i];
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
      if (!t || !slot.has(boardKey(t.board))) continue;
      edges++;
      join(i * NCELL + dr.cell, slot.get(boardKey(t.board)) * NCELL + t.cell);
    }
  }
  const roots = new Set();
  for (const i of slot.values()) {
    for (let c = 0; c < NCELL; c++) if (carved(boards[i], c)) roots.add(find(i * NCELL + c));
  }
  if (roots.size !== 1) errors.push(`band (${u},${v}): ${roots.size} components`);
  if (edges !== nodes - 1) errors.push(`band (${u},${v}): ${edges} edges for ${nodes} nodes`);
  return errors;
}

/**
 * Errors unless exactly one door crosses each wall of walked band `rb`
 * toward the band before or after it, and none crosses any other wall,
 * counted on both sides.
 */
function wallDoorErrors(world, rb) {
  const errors = [];
  const routeWalls = [rb.entry, rb.exit].filter(Boolean).map((d) => WALL_OF_DIR[d.dir]);
  for (let w = 0; w < 4; w++) {
    const d = WALL_DIR[w];
    let inside = 0, outside = 0;
    for (let i = 0; i < BANDW * BANDH; i++) {
      const { x, y } = boardCoords(rb.u, rb.v, i);
      if (inBand(x + DX[d], y + DY[d], rb.u, rb.v)) continue;
      const bd = world.board(x, y), nb = world.board(x + DX[d], y + DY[d]);
      if (bd.links) inside += bd.doors.filter((dr) => dr.dir === d).length;
      if (nb.links) outside += nb.doors.filter((dr) => dr.dir === (d ^ 2)).length;
    }
    const want = routeWalls.includes(w) ? 1 : 0;
    if (inside !== want || outside !== want) {
      errors.push(`${bandName(rb)} wall ${WALL_NAME[w]}: ${inside} doors inside and ${outside} outside, want ${want}`);
    }
  }
  return errors;
}

/** Per band: cells and doors form one tree; one door joins consecutive route bands and none crosses another band wall. */
export function checkTree(world, i0, i1) {
  const errors = [];
  for (const rb of walkRoute(world, i0, i1).bands) {
    errors.push(...bandTreeErrors(world, rb.u, rb.v));
    errors.push(...wallDoorErrors(world, rb));
  }
  return { errors };
}

/**
 * Primary pair of board i in band shape s: route boards join the doors to
 * their route neighbours, or the band's entry and exit doors at the route's
 * ends; a dead end pairs its parent door with -1 (deepest).
 */
function primaryPair(s, i) {
  const doorTo = (j) => s.adj[i].find((e) => e.to === j)?.cell;
  const r = s.route.indexOf(i);
  if (r < 0) return [s.adj[i].find((e) => s.depth[e.to] === s.depth[i] - 1).cell, -1];
  const a = r === 0 ? s.entry.cell : doorTo(s.route[r - 1]);
  const c = r === s.route.length - 1 ? s.exit.cell : doorTo(s.route[r + 1]);
  return [a, c];
}

/**
 * Dead ends reach at most 2 boards; boards meet section 4 or flag fallback;
 * a run of `minBoards` boards or more keeps fallbacks at or under 2%.
 */
export function checkBounds(world, i0, i1, minBoards = CEILING_MIN_BOARDS) {
  const errors = [];
  let boards = 0, fallbacks = 0;
  for (const rb of walkRoute(world, i0, i1).bands) {
    const s = bandShape(world, rb);
    errors.push(...s.errors);
    if (s.errors.length) continue;
    s.boards.forEach((bd, i) => {
      if (!bd.links) return;
      boards++;
      if (bd.fallback) fallbacks++;
      if (s.depth[i] < 0) { errors.push(`board (${bd.x},${bd.y}): cut off from the route`); return; }
      if (s.depth[i] > 2) errors.push(`board (${bd.x},${bd.y}): dead-end branch ${s.depth[i]} boards deep`);
      const [a, c] = primaryPair(s, i);
      const m = measureTargets(bd.links, a, c, bd.doors.map((d) => d.cell));
      if (!m.ok && !bd.fallback) {
        errors.push(`board (${bd.x},${bd.y}): misses targets (path ${m.pathLen}, junctions ${m.junctions}, short ${m.shortBranches}) without fallback`);
      }
    });
  }
  if (boards >= minBoards && 100 * fallbacks > CEILING_PERCENT * boards) {
    errors.push(`${fallbacks} of ${boards} boards (${(100 * fallbacks / boards).toFixed(1)}%) fall back, over the ${CEILING_PERCENT}% ceiling`);
  }
  return { errors, boards, fallbacks };
}

/** Tree boards of the bands the walk reaches. */
function walkedBoards(world, i0, i1) {
  const out = [];
  for (const rb of walkRoute(world, i0, i1).bands) for (const bd of bandBoards(world, rb.u, rb.v)) if (bd.links) out.push(bd);
  return out;
}

/**
 * Every gallery owns its 2x2 block: no other link joins two of its cells and
 * no cell lies in two blocks. Galleries average 4-10 per board.
 */
export function checkGalleries(world, i0, i1) {
  const errors = [];
  let boards = 0, galleries = 0, conflicts = 0;
  for (const bd of walkedBoards(world, i0, i1)) {
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
export function checkCarve(world, i0, i1) {
  const errors = [];
  let boards = 0, carved = 0;
  for (const bd of walkedBoards(world, i0, i1)) {
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
  const slot = new Map(boards.map((bd, i) => [boardKey(bd), i]));
  const ms = new Float64Array(boards.length * NCELL).fill(-1);
  const sA = slot.get(`${A.x},${A.y}`), sB = slot.get(`${B.x},${B.y}`);
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
      if (!t || !slot.has(boardKey(t.board))) continue;
      const tid = slot.get(boardKey(t.board)) * NCELL + t.cell;
      if (ms[tid] < 0) { ms[tid] = ms[id] + LINK_MS[dr.dir]; q.push(tid); }
    }
  }
  return ms[goal] < 0 ? Infinity : ms[goal];
}

const sameFlame = (f, g) => f.x === g.x && f.y === g.y && f.cell === g.cell;

/**
 * Chain faults of walked band `rb`: wrong ends, flames off the route or out
 * of order, unlit chain flames and route-board flames missing from every
 * chain. `prev` and `next` are the walked bands either side.
 */
function chainErrors(world, rb, s, span, prev, next) {
  const errors = [];
  const name = bandName(rb);
  const chain = world.bandFlames(rb.u, rb.v).chain;
  const chainNext = world.bandFlames(next.u, next.v).chain;
  const chainPrev = prev ? world.bandFlames(prev.u, prev.v).chain : [];
  if (!chain.length || chain[0].x !== s.entry.board.x || chain[0].y !== s.entry.board.y) errors.push(`${name}: chain does not start at the entry`);
  if (!chain.length || !chainNext.length || !sameFlame(chain[chain.length - 1], chainNext[0])) {
    errors.push(`${name}: chain does not end at ${bandName(next)}'s entry flame`);
  }
  let last = 0;
  for (const f of chain) {
    const o = span.findIndex((bd) => bd.x === f.x && bd.y === f.y);
    if (o < 0) errors.push(`${name}: chain flame on board (${f.x},${f.y}) is off the route`);
    else if (o < last) errors.push(`${name}: chain runs backwards at board (${f.x},${f.y})`);
    else last = o;
    if (!world.flamesAt(f.x, f.y).includes(f.cell)) errors.push(`${name}: chain flame (${f.x},${f.y}):${f.cell} is not lit`);
  }
  span.slice(0, -1).forEach((bd, r) => {
    for (const cell of world.flamesAt(bd.x, bd.y)) {
      const f = { x: bd.x, y: bd.y, cell };
      const known = chain.some((g) => sameFlame(f, g)) || (r === 0 && chainPrev.some((g) => sameFlame(f, g)));
      if (!known) errors.push(`${name}: route flame (${bd.x},${bd.y}):${cell} is missing from the chain`);
    }
  });
  return errors;
}

/** Band entries hold flames; consecutive route flames lie <= 150 s apart, across into the next route band. */
export function checkFlames(world, i0, i1) {
  const errors = [];
  const gaps = [];
  const walk = walkRoute(world, i0 - 1, i1 + 1);
  for (let i = i0; i <= i1; i++) {
    const rb = walk.at(i), next = walk.at(i + 1);
    if (!rb || !next) { errors.push(`route band ${i}: the walk does not reach it and the band after`); continue; }
    const s = bandShape(world, rb);
    errors.push(...s.errors);
    if (s.errors.length) continue;
    if (world.flamesAt(s.entry.board.x, s.entry.board.y).length === 0) errors.push(`${bandName(rb)}: entry holds no flame`);
    const span = [...s.route.map((j) => s.boards[j]), next.entry.board];
    errors.push(...chainErrors(world, rb, s, span, walk.at(i - 1), next));
    const chain = world.bandFlames(rb.u, rb.v).chain;
    for (let j = 0; j + 1 < chain.length; j++) {
      const t = walkMs(world, span, chain[j], chain[j + 1]);
      gaps.push(t);
      if (t > GAP_LIMIT_MS) errors.push(`${bandName(rb)}: flame gap ${(t / 1000).toFixed(1)} s exceeds 150 s`);
    }
  }
  return { errors, gaps };
}

/** BFS over cells and doors, within the walked bands, from route band i0's entry reaches route band i1's exit. */
export function checkSolvability(world, i0, i1) {
  const walk = walkRoute(world, i0, i1);
  const first = walk.at(i0), last = walk.at(i1);
  const fail = { errors: [`route band ${i1}'s exit is unreachable from route band ${i0}'s entry`], cells: 0 };
  if (!first || !first.entry || !last || !last.exit) return fail;
  const allowed = new Set(walk.bands.map((b) => bandKey(b.u, b.v)));
  const seen = new Map();
  const mark = (bd, c) => {
    let m = seen.get(boardKey(bd));
    if (!m) { m = new Uint8Array(NCELL); seen.set(boardKey(bd), m); }
    if (m[c]) return false;
    m[c] = 1;
    return true;
  };
  const goal = last.exit;
  const q = [[first.entry.board, first.entry.cell]];
  mark(first.entry.board, first.entry.cell);
  let cells = 0;
  for (let h = 0; h < q.length; h++) {
    const [bd, c] = q[h];
    cells++;
    if (bd.x === goal.board.x && bd.y === goal.board.y && c === goal.cell) return { errors: [], cells };
    for (let d = 0; d < 8; d++) {
      if (!(bd.links[c] & (1 << d))) continue;
      const t = nbCell(c, d);
      if (mark(bd, t)) q.push([bd, t]);
    }
    for (const dr of bd.doors) {
      if (dr.cell !== c) continue;
      const t = throughDoor(world, bd, dr);
      if (!t || !allowed.has(bandKey(Math.floor(t.board.x / BANDW), Math.floor(t.board.y / BANDH)))) continue;
      if (mark(t.board, t.cell)) q.push([t.board, t.cell]);
    }
  }
  return { ...fail, cells };
}

/** Saves round-trip at boards [x, y], and a resumed board matches one generated in sequence. */
export function checkSaves(world, positions) {
  const errors = [];
  const fresh = createWorld(world.code, world.options);
  for (const [x, y] of positions) {
    const p = posOf(x, y);
    const text = encodeSave(world.code, x, y);
    const back = decodeSave(text);
    if (!back || back.code !== world.code || back.p !== p || back.x !== x || back.y !== y) {
      errors.push(`save ${text} does not round-trip`);
    }
    const a = serializeBoard(world, x, y), b = serializeBoard(fresh, x, y);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) errors.push(`board at p=${p} differs when resumed`);
  }
  return { errors, saves: positions.length };
}

/**
 * Board of band (u, v) behind its crossing on wall w, from the bandv and
 * bandh keys of docs/ROUTE.md section 3, written apart from the generator.
 */
function crossingBoard(H, u, v, w) {
  if (w === 0) return { x: BANDW * u, y: BANDH * v + u32(H('bandv', u - 1, v)) % BANDH };
  if (w === 1) return { x: BANDW * u + BANDW - 1, y: BANDH * v + u32(H('bandv', u, v)) % BANDH };
  if (w === 2) return { x: BANDW * u + u32(H('bandh', u, v - 1)) % BANDW, y: BANDH * v };
  return { x: BANDW * u + u32(H('bandh', u, v)) % BANDW, y: BANDH * v + BANDH - 1 };
}

/**
 * For each walked band, ROUTE section 6 location from the coordinates
 * alone, in a fresh world, returns the walls and boards of the entry and
 * exit doors the walk followed.
 */
export function checkLocate(world, i0, i1) {
  const errors = [];
  const fresh = createWorld(world.code, world.options);
  const walk = walkRoute(world, i0, i1);
  for (const rb of walk.bands) {
    const loc = fresh.locate(rb.u, rb.v);
    if (!loc) { errors.push(`${bandName(rb)}: locates as rock`); continue; }
    for (const [end, w] of [['entry', loc.E], ['exit', loc.X]]) {
      const door = rb[end], want = crossingBoard(world.H, rb.u, rb.v, w);
      if (!door || door.dir !== WALL_DIR[w] || door.board.x !== want.x || door.board.y !== want.y) {
        const got = door ? `wall ${WALL_NAME[WALL_OF_DIR[door.dir]]} at board (${door.board.x},${door.board.y})` : 'no door';
        errors.push(`${bandName(rb)}: locates its ${end} at wall ${WALL_NAME[w]}, board (${want.x},${want.y}); the route follows ${got}`);
      }
    }
  }
  return { errors, bands: walk.bands.length };
}

/** Over consecutive bands [{ u, v }, ...], each direction carries 20-30% of moves. */
export function checkBalance(bands) {
  const errors = [];
  const counts = [0, 0, 0, 0];
  for (let i = 1; i < bands.length; i++) {
    const du = bands[i].u - bands[i - 1].u, dv = bands[i].v - bands[i - 1].v;
    const w = [0, 1, 2, 3].find((k) => WX[k] === du && WY[k] === dv);
    if (w === undefined) errors.push(`step ${i} moves (${du},${dv}), not to an adjacent band`);
    else counts[w]++;
  }
  const moves = counts.reduce((a, b) => a + b, 0);
  const shares = counts.map((n) => (moves ? (100 * n) / moves : 0));
  shares.forEach((s, w) => {
    if (s < BALANCE_MIN || s > BALANCE_MAX) errors.push(`${WALL_NAME[w]} carries ${s.toFixed(1)}% of ${moves} moves, outside ${BALANCE_MIN}-${BALANCE_MAX}%`);
  });
  return { errors, moves, shares };
}

/**
 * Start chain levels 1..levels each find a wall pair and a path. From level
 * 2 the path is a simple path of adjacent children from the entry wall to
 * the exit wall that holds child (1, 1), entered from its neighbour across
 * the level below's entry wall and left toward the one across its exit wall.
 */
export function checkStartChain(world, levels = START_LEVELS) {
  const errors = [];
  const step = (c, w) => {
    const x = (c % 3) + WX[w], y = ((c / 3) | 0) + WY[w];
    return x < 0 || x > 2 || y < 0 || y > 2 ? -1 : 3 * y + x;
  };
  // Children on wall w of the 3x3 grid.
  const onWall = (c, w) => [c % 3 === 0, c % 3 === 2, c < 3, c >= 6][w];
  let below = null;
  for (let k = 1; k <= levels; k++) {
    const c = world.startChain(k);
    if (!c) { errors.push(`level ${k}: no wall pair finds a path`); below = null; continue; }
    if (c.E === c.X) errors.push(`level ${k}: entry and exit share wall ${WALL_NAME[c.E]}`);
    if (k > 1) {
      const p = c.path || [];
      const name = `level ${k}`;
      if (new Set(p).size !== p.length) errors.push(`${name}: the path visits a child twice`);
      for (let i = 1; i < p.length; i++) if (![0, 1, 2, 3].some((w) => step(p[i - 1], w) === p[i])) errors.push(`${name}: children ${p[i - 1]} and ${p[i]} are not adjacent`);
      if (!p.length || !onWall(p[0], c.E) || !onWall(p[p.length - 1], c.X)) errors.push(`${name}: the path does not run from wall ${WALL_NAME[c.E]} to wall ${WALL_NAME[c.X]}`);
      const t = p.indexOf(4);
      if (t < 0) errors.push(`${name}: the path misses the centre child`);
      else if (below && (p[t - 1] !== step(4, below.E) || p[t + 1] !== step(4, below.X))) {
        errors.push(`${name}: the centre child is not entered across wall ${WALL_NAME[below.E]} and left across wall ${WALL_NAME[below.X]}`);
      }
    }
    below = c;
  }
  return { errors, levels };
}

/** A fixed seed code yields the pinned digest of route bands 0..99. */
export function checkDeterminism(code = SEED, want = DIGEST_0_99) {
  const got = digestBands(createWorld(code), 0, 99);
  return { errors: got === want ? [] : [`digest of route bands 0..99 is ${got}, pinned ${want}`], digest: got };
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** Each sampled band's entry board and one other board, about 40 positions. */
function saveSamples(world, i0, i1) {
  const samples = [];
  const bands = walkRoute(world, i0, i1).bands;
  const stride = Math.max(1, Math.floor(bands.length / 20));
  for (let n = 0; n < bands.length; n += stride) {
    const rb = bands[n];
    if (rb.entry) samples.push([rb.entry.board.x, rb.entry.board.y]);
    samples.push([BANDW * rb.u + (n % BANDW), BANDH * rb.v + 2]);
  }
  return samples;
}

/** Runs every check; returns [name, result, detail] rows and summary figures. */
function runChecks(world, code, i0, i1) {
  const rows = [];
  const k = checkKeccak();
  rows.push(['keccak', k, `${k.vectors} FIPS 202 vectors`]);
  const simple = checkSimpleRoute(world, i0, i1);
  rows.push(['simple route', simple, `${simple.bands} route bands walked through doors`]);
  rows.push(['walls', checkWalls(world, i0, i1), 'each band enters and leaves through different walls']);
  const flames = checkFlames(world, i0, i1);
  const gaps = flames.gaps.slice().sort((u, v) => u - v);
  const gapText = gaps.length ? `max ${(gaps.at(-1) / 1000).toFixed(1)} s, p99 ${(percentile(gaps, 0.99) / 1000).toFixed(1)} s` : 'none measured';
  const c = checkContinuity(world, i0, i1);
  rows.push(['continuity', c, `${c.doors} doors`]);
  rows.push(['tree', checkTree(world, i0, i1), 'edges = nodes - 1 per band; one door per route band pair']);
  const bounds = checkBounds(world, i0, i1);
  rows.push(['bounds', bounds, `${bounds.boards} boards, ${bounds.fallbacks} on best-attempt fallback`]);
  const galleries = checkGalleries(world, i0, i1);
  rows.push(['galleries', galleries, `${galleries.mean.toFixed(2)} per board, ${galleries.conflicts} block conflicts`]);
  const carve = checkCarve(world, i0, i1);
  rows.push(['carve', carve, `${carve.mean.toFixed(1)} carved cells per board`]);
  rows.push(['flames', flames, `${gaps.length} gaps, ${gapText}`]);
  const solve = checkSolvability(world, i0, i1);
  rows.push(['solvability', solve, `${solve.cells} cells searched`]);
  const saves = checkSaves(world, saveSamples(world, i0, i1));
  rows.push(['saves', saves, `${saves.saves} positions`]);
  const locate = checkLocate(world, i0, i1);
  rows.push(['locate', locate, `${locate.bands} bands located from coordinates`]);
  const balance = checkBalance(routeBands(world, 0, BALANCE_BANDS));
  const shareText = balance.shares.map((s, w) => `${WALL_NAME[w]} ${s.toFixed(1)}%`).join(' ');
  rows.push(['balance', balance, `${balance.moves} moves: ${shareText}`]);
  const level = world.startLevel();
  const start = checkStartChain(createWorld(code));
  rows.push(['start chain', start, `levels 1-${start.levels} each find a wall pair and a path`]);
  const det = code === SEED ? checkDeterminism() : { errors: [], digest: digestBands(createWorld(code), 0, 99) };
  rows.push(['determinism', det, `route bands 0..99 digest ${det.digest.slice(0, 16)}...`]);
  return { rows, bounds, galleries, carve, gapText, shareText, level, start };
}

function printRows(rows) {
  let failed = 0;
  for (const [name, r, detail] of rows) {
    const ok = r.errors.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${detail}`);
    for (const e of r.errors.slice(0, 10)) console.log(`      ${e}`);
    if (r.errors.length > 10) console.log(`      ... ${r.errors.length - 10} more`);
  }
  return failed;
}

async function main(argv) {
  const t0 = performance.now();
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const code = parseCode(arg('--code', SEED));
  const half = Number(arg('--bands', 1000));
  if (!code || !Number.isInteger(half) || half < 1) { console.error('usage: acceptance.mjs [--code XXXX-XXXX] [--bands N]'); return 2; }
  const i0 = -half, i1 = half;
  const { rows, bounds, galleries, carve, gapText, shareText, level, start } = runChecks(createWorld(code), code, i0, i1);
  const failed = printRows(rows);
  console.log('');
  console.log(`route bands:    ${i0}..${i1} (${i1 - i0 + 1}) for seed ${code.slice(0, 4)}-${code.slice(4)}`);
  console.log(`fallback boards: ${bounds.fallbacks} of ${bounds.boards} (${(100 * bounds.fallbacks / bounds.boards).toFixed(1)}%)`);
  console.log(`galleries:      ${galleries.mean.toFixed(2)} per board`);
  console.log(`block conflicts: ${galleries.conflicts}`);
  console.log(`carved cells:   ${carve.mean.toFixed(1)} per board (${(100 * carve.mean / NCELL).toFixed(0)}% of ${NCELL})`);
  console.log(`flame gap:      ${gapText}`);
  console.log(`balance:        ${shareText} over route bands 0..${BALANCE_BANDS}`);
  console.log(`start chain:    level ${level} built for the route; levels 1-${start.levels} checked`);
  console.log(`run time:       ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  console.log(failed ? `FAILED: ${failed} check(s)` : 'ALL CHECKS PASS');
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
