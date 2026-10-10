// Spec section 10 acceptance harness. Each check is an exported function over
// a world and returns { errors, ... }; it derives structure from boards, doors
// and links alone.
//
//   node tools/acceptance.mjs [--code XXXX-XXXX] [--bands N]
import { pathToFileURL } from 'node:url';
import { sha3_256 } from '../src/world/keccak.mjs';
import { parseCode, toHex } from '../src/world/hash.mjs';
import {
  createWorld, digestBands, serializeBoard, acrossDoor, posOf, boardOfPos, boardCoords, boardIndex,
} from '../src/world/world.mjs';
import { encodeSave, decodeSave } from '../src/world/save.mjs';

export const SEED = '00000000';
export const DIGEST_0_99 = 'a4cdd32a1e141af34b729c22d50d8ee4c6d1260717c52863b75ad239c4589b42';
export const GAP_LIMIT_MS = 150000;
export const GALLERIES_MIN = 4;
export const GALLERIES_MAX = 10;
// A run of CEILING_MIN_BOARDS or more boards fails above CEILING_PERCENT
// percent on fallback; shorter runs swing too far to enforce it.
export const CEILING_PERCENT = 2;
export const CEILING_MIN_BOARDS = 2000;

const BW = 12, BH = 7, NCELL = 84, BANDW = 6, BANDH = 4;
const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 1, 0, -1, 1, 1, -1, -1];
// Walking time per link in ms over 48 px cells at 96, 48 and 72 px/s.
const LINK_MS = [500, 1000, 500, 1000, 943, 943, 943, 943];

function nbCell(c, d) {
  const x = (c % BW) + DX[d], y = ((c / BW) | 0) + DY[d];
  return x < 0 || x >= BW || y < 0 || y >= BH ? -1 : y * BW + x;
}

function hasDoor(bd, dir, cell) {
  return !!bd.links && bd.doors.some((dr) => dr.dir === dir && dr.cell === cell);
}

function bandBoards(world, b) {
  const out = [];
  for (let i = 0; i < BANDW * BANDH; i++) {
    const { x, y } = boardCoords(b, i);
    out.push(world.board(x, y));
  }
  return out;
}

/** The board across wall d of `bd` when both sides hold the door, else null. */
function throughDoor(world, bd, dr) {
  const nx = bd.x + DX[dr.dir], ny = bd.y + DY[dr.dir];
  if (nx < 0 || nx >= BANDW) return null;
  const nb = world.board(nx, ny);
  const nc = acrossDoor(dr.cell, dr.dir);
  return hasDoor(nb, dr.dir ^ 2, nc) ? { board: nb, cell: nc } : null;
}

/** Boards of band b holding a floor door (entries) and a ceiling door (exits). */
function bandEnds(boards, b) {
  const has = (bd, dir) => bd.links && bd.doors.some((d) => d.dir === dir);
  const entries = boards.filter((bd) => bd.y === BANDH * b && has(bd, 3));
  const exits = boards.filter((bd) => bd.y === BANDH * b + 3 && has(bd, 1));
  const errors = [];
  if (entries.length !== 1) errors.push(`band ${b}: ${entries.length} floor doors`);
  if (exits.length !== 1) errors.push(`band ${b}: ${exits.length} ceiling doors`);
  return { entries, exits, errors };
}

/** Board adjacency of band b through doors held on both sides. */
function boardGraph(world, boards, b) {
  const adj = boards.map(() => []);
  for (const bd of boards) {
    if (!bd.links) continue;
    for (const dr of bd.doors) {
      if (dr.dir === 1 && bd.y === BANDH * b + 3) continue;
      if (dr.dir === 3 && bd.y === BANDH * b) continue;
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
 * Band structure from doors alone: entry and exit boards, the route between
 * them and each board's distance from the route.
 */
export function bandShape(world, b) {
  const boards = bandBoards(world, b);
  const { entries, exits, errors } = bandEnds(boards, b);
  const adj = boardGraph(world, boards, b);
  let route = [], depth = new Array(boards.length).fill(-1);
  if (entries.length >= 1 && exits.length >= 1) {
    ({ route, depth } = routeAndDepth(adj, boardIndex(entries[0].x, entries[0].y), boardIndex(exits[0].x, exits[0].y)));
    if (!route.length) errors.push(`band ${b}: no board route from entry to exit`);
  }
  return { boards, adj, route, depth, entry: entries[0], exit: exits[0], errors };
}

/** Path, junction and branch measures, written apart from the generator. */
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
  let junctions = 0, shortBranches = 0;
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
      if (!door && deepest < 3) shortBranches++;
    }
    if (branches) junctions++;
  }
  const ok = path.length >= 22 && junctions >= 6 && shortBranches === 0;
  return { ok, b, pathLen: path.length, junctions, shortBranches };
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
export function checkContinuity(world, b0, b1) {
  const errors = [];
  let doors = 0;
  for (let b = b0; b <= b1; b++) {
    for (const bd of bandBoards(world, b)) {
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

/** Errors when band b's cells and doors are not one tree (edges = nodes - 1). */
function bandTreeErrors(world, b) {
  const errors = [];
  const boards = bandBoards(world, b);
  const slot = new Map();
  boards.forEach((bd, i) => { if (bd.links) slot.set(bd.p, i); });
  const up = new Int32Array(boards.length * NCELL).map((_, i) => i);
  const find = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const join = (u, v) => { up[find(u)] = find(v); };
  let nodes = 0, edges = 0;
  for (const i of slot.values()) {
    const bd = boards[i];
    nodes += NCELL;
    for (let c = 0; c < NCELL; c++) {
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
      if (!t || !slot.has(t.board.p)) continue;
      edges++;
      join(i * NCELL + dr.cell, slot.get(t.board.p) * NCELL + t.cell);
    }
  }
  const roots = new Set();
  for (const i of slot.values()) for (let c = 0; c < NCELL; c++) roots.add(find(i * NCELL + c));
  if (roots.size !== 1) errors.push(`band ${b}: ${roots.size} components`);
  if (edges !== nodes - 1) errors.push(`band ${b}: ${edges} edges for ${nodes} nodes`);
  return errors;
}

/** Errors unless exactly one door joins bands b-1 and b, held on both sides. */
function seamErrors(world, b) {
  let down = 0, upward = 0;
  for (let x = 0; x < BANDW; x++) {
    const top = world.board(x, BANDH * b - 1), bottom = world.board(x, BANDH * b);
    if (top.links) upward += top.doors.filter((d) => d.dir === 1).length;
    if (bottom.links) down += bottom.doors.filter((d) => d.dir === 3).length;
  }
  return down === 1 && upward === 1 ? [] : [`bands ${b - 1}/${b}: ${upward} ceiling and ${down} floor doors`];
}

/** Per band: cells and doors form one tree; one door joins each band pair. */
export function checkTree(world, b0, b1) {
  const errors = [];
  for (let b = b0; b <= b1; b++) errors.push(...bandTreeErrors(world, b));
  for (let b = b0; b <= b1 + 1; b++) errors.push(...seamErrors(world, b));
  return { errors };
}

/**
 * Primary pair of board i in band shape s: route boards join the doors to
 * their route neighbours; a dead end pairs its parent door with -1 (deepest).
 */
function primaryPair(s, i, bd) {
  const doorTo = (j) => s.adj[i].find((e) => e.to === j)?.cell;
  const r = s.route.indexOf(i);
  if (r < 0) return [s.adj[i].find((e) => s.depth[e.to] === s.depth[i] - 1).cell, -1];
  const a = r === 0 ? bd.doors.find((d) => d.dir === 3).cell : doorTo(s.route[r - 1]);
  const c = r === s.route.length - 1 ? bd.doors.find((d) => d.dir === 1).cell : doorTo(s.route[r + 1]);
  return [a, c];
}

/**
 * Dead ends reach at most 2 boards; boards meet section 4 or flag fallback;
 * a run of `minBoards` boards or more keeps fallbacks at or under 2%.
 */
export function checkBounds(world, b0, b1, minBoards = CEILING_MIN_BOARDS) {
  const errors = [];
  let boards = 0, fallbacks = 0;
  for (let b = b0; b <= b1; b++) {
    const s = bandShape(world, b);
    errors.push(...s.errors);
    if (s.errors.length) continue;
    s.boards.forEach((bd, i) => {
      if (!bd.links) return;
      boards++;
      if (bd.fallback) fallbacks++;
      if (s.depth[i] < 0) { errors.push(`board (${bd.x},${bd.y}): cut off from the route`); return; }
      if (s.depth[i] > 2) errors.push(`board (${bd.x},${bd.y}): dead-end branch ${s.depth[i]} boards deep`);
      const [a, c] = primaryPair(s, i, bd);
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

/**
 * Every gallery owns its 2x2 block: no other link joins two of its cells and
 * no cell lies in two blocks. Galleries average 4-10 per board.
 */
export function checkGalleries(world, b0, b1) {
  const errors = [];
  let boards = 0, galleries = 0, conflicts = 0;
  for (let b = b0; b <= b1; b++) {
    for (const bd of bandBoards(world, b)) {
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
  }
  const mean = boards ? galleries / boards : 0;
  if (mean < GALLERIES_MIN || mean > GALLERIES_MAX) {
    errors.push(`galleries per board average ${mean.toFixed(2)}, outside ${GALLERIES_MIN}-${GALLERIES_MAX}`);
  }
  return { errors, boards, galleries, conflicts, mean };
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
 * Chain faults of band b: wrong ends, flames off the route or out of order,
 * unlit chain flames and route-board flames missing from every chain.
 */
function chainErrors(world, b, s, span) {
  const errors = [];
  const chain = world.bandFlames(b).chain;
  const chainNext = world.bandFlames(b + 1).chain;
  const chainPrev = world.bandFlames(b - 1).chain;
  if (!chain.length || chain[0].x !== s.entry.x || chain[0].y !== s.entry.y) errors.push(`band ${b}: chain does not start at the entry`);
  if (!sameFlame(chain[chain.length - 1], chainNext[0])) errors.push(`band ${b}: chain does not end at band ${b + 1}'s entry flame`);
  let last = 0;
  for (const f of chain) {
    const o = span.findIndex((bd) => bd.x === f.x && bd.y === f.y);
    if (o < 0) errors.push(`band ${b}: chain flame on board (${f.x},${f.y}) is off the route`);
    else if (o < last) errors.push(`band ${b}: chain runs backwards at board (${f.x},${f.y})`);
    else last = o;
    if (!world.flamesAt(f.x, f.y).includes(f.cell)) errors.push(`band ${b}: chain flame (${f.x},${f.y}):${f.cell} is not lit`);
  }
  span.slice(0, -1).forEach((bd, r) => {
    for (const cell of world.flamesAt(bd.x, bd.y)) {
      const f = { x: bd.x, y: bd.y, cell };
      const known = chain.some((g) => sameFlame(f, g)) || (r === 0 && chainPrev.some((g) => sameFlame(f, g)));
      if (!known) errors.push(`band ${b}: route flame (${bd.x},${bd.y}):${cell} is missing from the chain`);
    }
  });
  return errors;
}

/** Band entries hold flames; consecutive route flames lie <= 150 s apart. */
export function checkFlames(world, b0, b1) {
  const errors = [];
  const gaps = [];
  for (let b = b0; b <= b1; b++) {
    const s = bandShape(world, b);
    errors.push(...s.errors);
    if (s.errors.length) continue;
    if (world.flamesAt(s.entry.x, s.entry.y).length === 0) errors.push(`band ${b}: entry holds no flame`);
    const next = bandShape(world, b + 1);
    if (next.errors.length) { errors.push(...next.errors); continue; }
    const span = [...s.route.map((i) => s.boards[i]), next.entry];
    errors.push(...chainErrors(world, b, s, span));
    const chain = world.bandFlames(b).chain;
    for (let i = 0; i + 1 < chain.length; i++) {
      const t = walkMs(world, span, chain[i], chain[i + 1]);
      gaps.push(t);
      if (t > GAP_LIMIT_MS) errors.push(`band ${b}: flame gap ${(t / 1000).toFixed(1)} s exceeds 150 s`);
    }
  }
  return { errors, gaps };
}

/** BFS over cells and doors from band b0's entry reaches band b1's exit. */
export function checkSolvability(world, b0, b1) {
  const s0 = bandShape(world, b0), s1 = bandShape(world, b1);
  if (s0.errors.length || s1.errors.length) return { errors: [...s0.errors, ...s1.errors], cells: 0 };
  const startCell = s0.entry.doors.find((d) => d.dir === 3).cell;
  const goalCell = s1.exit.doors.find((d) => d.dir === 1).cell;
  const seen = new Map();
  const mark = (p, c) => {
    let m = seen.get(p);
    if (!m) { m = new Uint8Array(NCELL); seen.set(p, m); }
    if (m[c]) return false;
    m[c] = 1;
    return true;
  };
  const q = [s0.entry.p * 128 + startCell];
  mark(s0.entry.p, startCell);
  const lo = BANDH * b0, hi = BANDH * b1 + 3;
  let reached = false, cells = 0;
  for (let h = 0; h < q.length; h++) {
    const p = Math.floor(q[h] / 128), c = q[h] - p * 128;
    cells++;
    const { x, y } = boardOfPos(p);
    if (p === s1.exit.p && c === goalCell) { reached = true; break; }
    const bd = world.board(x, y);
    for (let d = 0; d < 8; d++) {
      if (!(bd.links[c] & (1 << d))) continue;
      const t = nbCell(c, d);
      if (mark(p, t)) q.push(p * 128 + t);
    }
    for (const dr of bd.doors) {
      if (dr.cell !== c) continue;
      const t = throughDoor(world, bd, dr);
      if (!t || t.board.y < lo || t.board.y > hi) continue;
      if (mark(t.board.p, t.cell)) q.push(t.board.p * 128 + t.cell);
    }
  }
  return { errors: reached ? [] : [`band ${b1}'s exit is unreachable from band ${b0}'s entry`], cells };
}

/** Saves round-trip, and a resumed board matches one generated in sequence. */
export function checkSaves(world, positions) {
  const errors = [];
  const fresh = createWorld(world.code);
  for (const p of positions) {
    const { x, y } = boardOfPos(p);
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

/** A fixed seed code yields the pinned digest of bands 0..99. */
export function checkDeterminism(code = SEED, want = DIGEST_0_99) {
  const got = digestBands(createWorld(code), 0, 99);
  return { errors: got === want ? [] : [`digest of bands 0..99 is ${got}, pinned ${want}`], digest: got };
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function saveSamples(world, b0, b1) {
  const samples = [];
  for (let b = b0; b <= b1; b += Math.max(1, Math.floor((b1 - b0) / 20))) {
    samples.push(posOf(world.tree(b).entryX, BANDH * b), posOf(((b % BANDW) + BANDW) % BANDW, BANDH * b + 2));
  }
  return samples;
}

/** Runs every check; returns [name, result, detail] rows and summary figures. */
function runChecks(world, code, b0, b1) {
  const rows = [];
  const k = checkKeccak();
  rows.push(['keccak', k, `${k.vectors} FIPS 202 vectors`]);
  const flames = checkFlames(world, b0, b1);
  const gaps = flames.gaps.slice().sort((u, v) => u - v);
  const gapText = `max ${(gaps.at(-1) / 1000).toFixed(1)} s, p99 ${(percentile(gaps, 0.99) / 1000).toFixed(1)} s`;
  const c = checkContinuity(world, b0, b1);
  rows.push(['continuity', c, `${c.doors} doors`]);
  rows.push(['tree', checkTree(world, b0, b1), 'edges = nodes - 1 per band; one door per band pair']);
  const bounds = checkBounds(world, b0, b1);
  rows.push(['bounds', bounds, `${bounds.boards} boards, ${bounds.fallbacks} on best-attempt fallback`]);
  const galleries = checkGalleries(world, b0, b1);
  rows.push(['galleries', galleries, `${galleries.mean.toFixed(2)} per board, ${galleries.conflicts} block conflicts`]);
  rows.push(['flames', flames, `${gaps.length} gaps, ${gapText}`]);
  const solve = checkSolvability(world, b0, b1);
  rows.push(['solvability', solve, `${solve.cells} cells searched`]);
  const saves = checkSaves(world, saveSamples(world, b0, b1));
  rows.push(['saves', saves, `${saves.saves} positions`]);
  const det = code === SEED ? checkDeterminism() : { errors: [], digest: digestBands(createWorld(code), 0, 99) };
  rows.push(['determinism', det, `bands 0..99 digest ${det.digest.slice(0, 16)}...`]);
  return { rows, bounds, galleries, gapText };
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
  const b0 = -half, b1 = half;
  const { rows, bounds, galleries, gapText } = runChecks(createWorld(code), code, b0, b1);
  const failed = printRows(rows);
  console.log('');
  console.log(`bands checked:  ${b0}..${b1} (${b1 - b0 + 1}) for seed ${code.slice(0, 4)}-${code.slice(4)}`);
  console.log(`fallback boards: ${bounds.fallbacks} of ${bounds.boards} (${(100 * bounds.fallbacks / bounds.boards).toFixed(1)}%)`);
  console.log(`galleries:      ${galleries.mean.toFixed(2)} per board`);
  console.log(`block conflicts: ${galleries.conflicts}`);
  console.log(`flame gap:      ${gapText}`);
  console.log(`run time:       ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  console.log(failed ? `FAILED: ${failed} check(s)` : 'ALL CHECKS PASS');
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
