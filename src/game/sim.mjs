// Simulation: the explorer moves along the cell graph, so motion admits
// exactly the tree's links. A jump is an air state of the current cell: on
// the ground or in the air, the explorer leaves a cell only along a link or
// door. A let-go drops from a ladder over its lower cell. Runs on a fixed
// 60 Hz tick; no DOM.
import { DX, DY, BW, NCELL } from '../world/board.mjs';
import { floorItems, itemSpot, coinRows, rowSpot, ROW_COINS } from '../world/floor.mjs';
import { tombOf } from '../world/world.mjs';
import { coinId, tombItems } from './wallet.mjs';

export const TICK = 1 / 60;
export const CELL = 48;
export const BOARD_W = 576;
export const BOARD_H = 336;
export const RUN_SPEED = 96;
export const GALLERY_SPEED = 72;
export const LADDER_SPEED = 48;
export const BURN_S = 300;
export const EMBER_S = 10;
// Burn an oil jar adds, capped at BURN_S.
export const JAR_S = 60;
export const R_FULL = 96;
export const R_LOW = 24;
export const R_EMBER = 8;
export const SCONCE_R = 64;
// A 128 px/s launch under 512 px/s^2 peaks at 16 px after 0.25 s and lands
// after 0.5 s; the per-tick integration is exact, so no floor jump rises past
// ROOM_CLEAR.
export const JUMP_SPEED = 128;
export const GRAVITY = 512;
// Head room over a room's floor: interior 32 px less the tucked explorer's 16.
export const ROOM_CLEAR = 16;
// Largest offset that keeps the explorer inside a 16 px ladder shaft.
export const SHAFT_REACH = 3;
// Held Up engages an up-gallery once its landing point comes this close to the stair.
export const STAIR_REACH = 4;
// An Up or Down tap stays buffered 150 ms (9 ticks) past its release tick.
export const BUFFER_TICKS = 9;
// Key bits of press and release edges.
export const KEY = { L: 1, R: 2, U: 4, D: 8 };
const NO_EDGES = { press: 0, release: 0 };
// Floor reach from the cell centre toward a wall: interior half-width 16
// less the explorer's half-width 5.
const WALL_REACH = 11;
// The explorer's half-width: its leading foot sits this far from the feet.
const HALF_W = 5;
const TOUCH = 12;

/** World position of a cell's standing point (centre, on the floor). */
export function nodeXY(bd, cell) {
  return [nodeX(bd, cell), nodeY(bd, cell)];
}

function nodeX(bd, cell) {
  return bd.x * BOARD_W + (cell % BW) * CELL + 24;
}

function nodeY(bd, cell) {
  return bd.y * BOARD_H + ((cell / BW) | 0) * CELL + 8;
}

/** Light radius: the lit area, radius squared, falls linearly from 96 px full to 24 px at 10% burn. */
export function torchRadius(burn) {
  if (burn <= 0) return R_EMBER;
  const f = burn / BURN_S;
  if (f <= 0.1) return R_LOW;
  return Math.sqrt(R_LOW * R_LOW + (R_FULL * R_FULL - R_LOW * R_LOW) * (f - 0.1) / 0.9);
}

/** Press and release edges, as KEY bits, between held inputs (h0, v0) and (h1, v1). */
export function inputEdges(h0, v0, h1, v1) {
  const bits = (h, v) => (h < 0 ? KEY.L : 0) | (h > 0 ? KEY.R : 0) | (v > 0 ? KEY.U : 0) | (v < 0 ? KEY.D : 0);
  const a = bits(h0, v0), b = bits(h1, v1);
  return { press: b & ~a, release: a & ~b };
}

/**
 * What the explorer has done: per board, keyed by board coordinates because
 * `world.retain` rebuilds board objects, the cells stood on and, per cell, the
 * directions of the links and doors it walked, each recorded at both ends.
 */
export function createTrail() {
  return new Map();
}

const trailKey = (x, y) => `${x},${y}`;

/** The trail's record of board (x, y): `stood` and `walked` per cell, or undefined. */
export function trailAt(trail, x, y) {
  return trail.get(trailKey(x, y));
}

function trailBoard(trail, bd) {
  let t = trailAt(trail, bd.x, bd.y);
  if (!t) {
    t = { x: bd.x, y: bd.y, stood: new Uint8Array(NCELL), walked: new Uint8Array(NCELL) };
    trail.set(trailKey(bd.x, bd.y), t);
  }
  return t;
}

export function recordStood(trail, bd, cell) {
  trailBoard(trail, bd).stood[cell] = 1;
}

/** Records link or door d from (bd, cell) to (to.board, to.cell), standing on both ends. */
function recordWalk(trail, bd, cell, d, to) {
  const a = trailBoard(trail, bd), b = trailBoard(trail, to.board);
  a.stood[cell] = 1;
  b.stood[to.cell] = 1;
  a.walked[cell] |= 1 << d;
  b.walked[to.cell] |= 1 << (d ^ 2);
}

/**
 * Everything a Continue carries into the next run: its start tomb, continue
 * count and the takes of the two recent tombs, which read as where the
 * explorer has just been.
 */
export function runCarry(s) {
  return {
    time: s.time, solved: s.solved, lastEntry: s.lastEntry, trail: s.trail, start: s.start, continues: s.continues,
    recent: s.recent, collected: s.collected, jars: s.jars,
  };
}

const tombKey = (bd) => `${bd.u},${bd.v}`;

/** The tomb "u,v" holding the board that coin or jar id `x,y,n` names. */
function idTomb(world, id) {
  const [x, y] = id.split(',', 2).map(Number);
  const t = tombOf(x, y, world.size);
  return `${t.u},${t.v}`;
}

/**
 * True when tomb (u, v) lies on the run's way on: its start tomb, the tomb
 * that tomb's exit leads to, and so on. The way on never descends, so it is
 * walked only up to row v, and only once.
 */
function onWayOn(s, u, v) {
  const w = s.wayOn;
  while (w.v <= v) {
    const d = s.world.exit(w.u, w.v);
    w.u += DX[d];
    w.v += DY[d];
    w.tombs.add(`${w.u},${w.v}`);
  }
  return w.tombs.has(`${u},${v}`);
}

/**
 * The run's tomb count: the tombs solved on its way on, which the HUD shows as
 * TOMB n. main.mjs reads `s.solved` for the tomb pay.
 */
export function tombCount(s) {
  return s.solved.size;
}

/**
 * A run from `start` = { board, cell }, standing on the door's cell. The run
 * remembers the takes of its two recent tombs, latest first: the one it stands
 * in and the one before. `collected` is the set of the coin ids (`coinId`) and
 * `jars` the set of the jar ids taken in those tombs; the sim adds an id on
 * each pickup, drops a tomb's ids when it leaves the recent tombs and touches
 * no storage. A carry's recent tombs and takes apply to the tomb the sim
 * starts in: when it is one of them it moves to the front and both stay;
 * otherwise it comes first, the carried latest follows and the older tomb's
 * takes lie back.
 */
export function createSim(world, start, carry = null, { collected = new Set() } = {}) {
  const here = tombKey(start.board);
  const recent = [here, ...(carry && carry.recent ? carry.recent.filter((key) => key !== here) : [])].slice(0, 2);
  const s = {
    world, bd: start.board, cell: start.cell,
    mode: 'floor', off: 0, alt: 0, vy: 0, link: -1, to: null, prog: 0, len: 0,
    facing: 1, moving: false, burn: BURN_S, ember: 0,
    tap: 0, buffer: 0, bufferTicks: 0, queued: 0, dismount: 0, noAirGrab: false,
    state: 'play', time: carry ? carry.time : 0,
    // The score: the tombs solved, each counted once, keyed "u,v".
    solved: carry && carry.solved ? carry.solved : new Set(),
    // The run's start tomb, which Continue carries, and its way on walked so far.
    start: carry && carry.start ? carry.start : { u: start.board.u, v: start.board.v },
    wayOn: null,
    // The times the run went on after its torch died, which a Continue raises.
    continues: carry && carry.continues ? carry.continues : 0,
    lastEntry: start.board.entry ? start.board.p : (carry ? carry.lastEntry : start.board.p),
    touching: false, walked: 0, climbed: 0, carry: 0,
    stats: {
      corridor: 0, ladderUp: 0, seams: 0, flames: 0, jumps: 0, airGrabs: 0, stairLandings: 0, dismounts: 0, letGos: 0,
    },
    collected,
    // The oil jars taken in the recent tombs, keyed as coins are.
    jars: new Set(),
    // The recent tombs' keys "u,v", the explorer's tomb first; `items` holds each one's item list,
    // read once while the tomb stays recent so that a slot write builds no board.
    recent,
    items: new Map(recent.map((key) => [key, tombItems(world, key)])),
    events: [],
    trail: carry && carry.trail ? carry.trail : createTrail(),
  };
  if (carry) {
    for (const id of carry.collected || []) if (recent.includes(idTomb(world, id))) collected.add(id);
    for (const id of carry.jars || []) if (recent.includes(idTomb(world, id))) s.jars.add(id);
  }
  s.wayOn = { u: s.start.u, v: s.start.v, tombs: new Set([`${s.start.u},${s.start.v}`]) };
  recordStood(s.trail, s.bd, s.cell);
  return s;
}

export function canGo(s, d) {
  return !!s.world.step(s.bd, s.cell, d);
}

/** The cell's up-link (v > 0) or down-link (v < 0): ladder, door or gallery; -1 if none. */
function linkToward(s, v) {
  for (const d of v > 0 ? [1, 4, 5] : [3, 7, 6]) if (canGo(s, d)) return d;
  return -1;
}

/** The up-link and its stair: +1 or -1, the side an up-gallery rises toward, else 0. */
function upLink(s) {
  const up = linkToward(s, 1);
  return { up, stair: up >= 4 ? DX[up] : 0 };
}

/** The cell's galleries on side h: its foot or mouth. */
function sideGalleries(s, h) {
  return (h > 0 ? [4, 7] : [5, 6]).filter((e) => canGo(s, e));
}

/** Reach toward side h: unbounded through a corridor or door, 0 at a gallery foot or mouth, else the wall. */
function sideLimit(s, h) {
  if (canGo(s, h > 0 ? 0 : 2)) return Infinity;
  return sideGalleries(s, h).length ? 0 : WALL_REACH;
}

/** The link vertical intent v picks: the cell's link that way, unless h points away from its gallery. */
function pickLink(s, h, v) {
  if (v === 0) return -1;
  const d = linkToward(s, v);
  return d >= 4 && h === -DX[d] ? -1 : d;
}

function engage(s, d, prog = 0) {
  s.mode = 'link';
  s.link = d;
  s.to = s.world.step(s.bd, s.cell, d);
  s.len = d < 4 ? CELL : CELL * Math.SQRT2;
  s.prog = prog;
  s.off = 0;
  s.alt = 0;
  s.vy = 0;
  // The engaged link spends the vertical intent that chose it.
  s.tap &= ~(DY[d] > 0 ? KEY.U : KEY.D);
  if (s.buffer === DY[d]) s.buffer = 0;
  s.queued = 0;
  s.dismount = 0;
}

/** Removes the ids of tomb `key` from take set `set`. */
function forget(s, set, key) {
  for (const id of set) if (idTomb(s.world, id) === key) set.delete(id);
}

/**
 * The explorer moves from tomb `from` to the tomb of `bd`: the list becomes
 * [bd's tomb, from], and a tomb that leaves it lays its takes back.
 */
function enterTomb(s, from, bd) {
  const recent = [tombKey(bd), tombKey(from)];
  for (const key of s.recent) {
    if (recent.includes(key)) continue;
    s.items.delete(key);
    forget(s, s.collected, key);
    forget(s, s.jars, key);
  }
  for (const key of recent) if (!s.items.has(key)) s.items.set(key, tombItems(s.world, key));
  s.recent = recent;
}

/**
 * Crossing a seam. A tomb is solved when the explorer leaves it through its
 * exit door and it lies on the run's way on; a tomb upstream of that way
 * never counts, whatever door the explorer used. A change of tomb moves the
 * recent tombs.
 */
function enterBoard(s, bd) {
  if (bd === s.bd) return;
  s.stats.seams++;
  s.events.push('seam');
  const from = s.bd;
  if (bd.u !== from.u || bd.v !== from.v) {
    const d = bd.u > from.u ? 0 : bd.v > from.v ? 1 : bd.u < from.u ? 2 : 3;
    const key = tombKey(from);
    if (s.world.exit(from.u, from.v) === d && !s.solved.has(key) && onWayOn(s, from.u, from.v)) {
      s.solved.add(key);
      s.events.push('solved');
    }
    enterTomb(s, from, bd);
  }
  if (bd.entry && bd.p !== s.lastEntry) { s.lastEntry = bd.p; s.events.push('entry'); }
}

/** Moves to the far cell of the current link. */
function arrive(s) {
  enterBoard(s, s.to.board);
  s.bd = s.to.board;
  s.cell = s.to.cell;
}

/** Moves through the corridor or door on side h once the offset passes the cell edge. */
function crossCell(s, h) {
  const nb = s.world.step(s.bd, s.cell, h > 0 ? 0 : 2);
  enterBoard(s, nb.board);
  s.bd = nb.board;
  s.cell = nb.cell;
  s.off -= h * CELL;
  s.queued = 0;
  s.stats.corridor++;
}

/**
 * A Left or Right press turns the explorer at once and, on a ladder, commits
 * a dismount to its nearer end, the far one from len/2; engage clears a
 * press made off a link. An Up or Down press made off a link is a tap until a
 * link engages; its release buffers the intent. An Up press ends a let-go's
 * hold on air grabs.
 */
function readEdges(s, { press, release }) {
  if (press & KEY.L && !(press & KEY.R)) s.facing = -1;
  else if (press & KEY.R && !(press & KEY.L)) s.facing = 1;
  if (press & (KEY.L | KEY.R) && s.link < 4) s.dismount = s.prog >= s.len / 2 ? 1 : -1;
  if (press & KEY.U) s.noAirGrab = false;
  for (const [key, dir] of [[KEY.U, 1], [KEY.D, -1]]) {
    if (press & key && s.mode !== 'link') s.tap |= key;
    if (release & key && s.tap & key) {
      s.tap &= ~key;
      s.buffer = dir;
      s.bufferTicks = BUFFER_TICKS;
    }
  }
}

/** A buffered tap that finds a link here holds until the link engages. */
function takeBuffer(s, h, v) {
  if (v === 0 && s.buffer && pickLink(s, h, s.buffer) >= 0) {
    s.queued = s.buffer;
    s.buffer = 0;
  }
}

function floorMove(s, h, v, dt) {
  if (v !== 0 && v !== s.queued) s.queued = 0;
  takeBuffer(s, h, v);
  const d = pickLink(s, h, v || s.queued);
  if (d < 0) s.queued = 0;
  const stepPx = RUN_SPEED * dt;
  if (d >= 0) {
    // Slide to the link's foot facing the gallery, or keeping facing for a ladder.
    if (d >= 4) s.facing = DX[d];
    if (Math.abs(s.off) > stepPx) {
      s.off -= Math.sign(s.off) * stepPx;
      s.moving = true;
      s.walked += stepPx;
      return;
    }
    const used = Math.abs(s.off) / RUN_SPEED;
    s.walked += Math.abs(s.off);
    engage(s, d);
    linkMove(s, h, v, dt - used);
    return;
  }
  if (h === 0) { s.moving = false; return; }
  s.facing = h;
  const hd = h > 0 ? 0 : 2;
  let next = s.off + h * stepPx;
  if (!canGo(s, hd)) {
    const diags = sideGalleries(s, h);
    if (diags.length === 1 && s.off * h <= 0 && next * h >= 0) {
      const used = Math.abs(s.off) / RUN_SPEED;
      s.walked += Math.abs(s.off);
      engage(s, diags[0]);
      linkMove(s, h, diags[0] < 6 ? 1 : -1, dt - used);
      return;
    }
  }
  // A gallery foot or mouth on this side leaves no floor past the centre.
  const lim = sideLimit(s, h);
  if (next * h > lim) next = Math.max(s.off * h, lim) * h;
  s.moving = next !== s.off;
  s.walked += Math.abs(next - s.off);
  s.off = next;
  if (s.off * h > CELL / 2) {
    crossCell(s, h);
    // The cell entered reads the buffer in the tick that enters it.
    takeBuffer(s, h, v);
  }
}

function linkMove(s, h, v, dt) {
  const d = s.link;
  // On a ladder, Up or Down held cancels a dismount.
  if (v !== 0) s.dismount = 0;
  const along = d < 4 ? s.dismount || v * DY[d] : Math.sign(h * DX[d] + v * DY[d]);
  if (along === 0) { s.moving = false; return; }
  const speed = d < 4 ? LADDER_SPEED : GALLERY_SPEED;
  s.prog += along * speed * dt;
  s.moving = true;
  if (d < 4) s.climbed += speed * dt;
  else { s.walked += speed * dt; s.facing = DX[d] * along; }
  // A link always ends at its node; unspent tick time carries to the next
  // tick. `past`: how far the move passed the end it heads for; rounding can
  // leave it a hair short, which carries nothing.
  const past = along > 0 ? s.prog - s.len : -s.prog;
  if (past < -1e-9) return;
  s.carry = Math.max(0, past) / speed;
  if (along > 0) {
    if (d === 1) s.stats.ladderUp++;
    arrive(s);
  }
  if (s.dismount) s.stats.dismounts++;
  s.mode = 'floor';
  s.off = 0;
}

function launch(s) {
  s.mode = 'air';
  s.alt = 0;
  s.vy = JUMP_SPEED;
  s.queued = 0;
  s.stats.jumps++;
}

/**
 * A jump on a ladder. At prog 0 the explorer stands on the floor it engaged
 * from and jumps from it. Elsewhere it lets go: it drops from its feet's
 * height, at zero vertical speed, over the ladder's lower cell, reached from
 * a down-ladder along the link. Held Up then grabs nothing until pressed anew
 * or the explorer lands.
 */
function letGo(s) {
  if (s.prog <= 0) { launch(s); return; }
  s.mode = 'air';
  s.vy = 0;
  s.noAirGrab = true;
  s.stats.letGos++;
  if (DY[s.link] > 0) { s.alt = s.prog; return; }
  arrive(s);
  s.alt = s.len - s.prog;
}

/**
 * Air over the current cell: `alt` is the feet's height over its floor. The
 * floor's side limits hold, except over the cell's up-stair, where the stair
 * bounds the landing point from below: the leading foot once it passes the
 * room wall, where stair rock lies, else the feet. The air ends on the floor
 * or on a link.
 */
function airMove(s, h, v, dt) {
  let { up, stair } = upLink(s);
  if (h !== 0) {
    s.facing = h;
    let next = s.off + h * RUN_SPEED * dt;
    let lim = h === stair ? CELL / 2 : sideLimit(s, h);
    // A head in the ladder shaft stays within it. Rounding in the arc can pass
    // ROOM_CLEAR by about 1e-14 px, which is no rise into the shaft.
    if (s.alt > ROOM_CLEAR + 1e-9) lim = Math.min(lim, SHAFT_REACH);
    if (next * h > lim) next = Math.max(s.off * h, lim) * h;
    s.moving = next !== s.off;
    s.walked += Math.abs(next - s.off);
    s.off = next;
    if (s.off * h > CELL / 2) {
      crossCell(s, h);
      ({ up, stair } = upLink(s));
    }
  }
  s.alt += s.vy * dt - GRAVITY * dt * dt / 2;
  s.vy -= GRAVITY * dt;
  // k: the up-stair's height under the feet, positive over the stair; land:
  // the stair's height under the landing point. A landing keeps the feet's x.
  const k = stair ? s.off * stair : -1;
  const land = k > WALL_REACH ? k + HALF_W : k;
  if (k > 0 && s.alt <= land) {
    s.stats.stairLandings++;
    engage(s, up, k * Math.SQRT2);
    return;
  }
  if (s.alt <= 0) {
    s.mode = 'floor';
    s.alt = 0;
    s.vy = 0;
    s.noAirGrab = false;
    return;
  }
  if (v <= 0 || s.noAirGrab || (stair && h === -stair)) return;
  if (k >= 0 && s.alt - land <= STAIR_REACH) {
    s.stats.airGrabs++;
    engage(s, up, k * Math.SQRT2);
  } else if (up === 1 && Math.abs(s.off) <= SHAFT_REACH) {
    s.stats.airGrabs++;
    engage(s, 1, s.alt);
  }
}

/** Feet x in world px; allocates nothing. */
export function feetX(s) {
  const nx = nodeX(s.bd, s.cell);
  if (s.mode !== 'link') return nx + s.off;
  return nx + DX[s.link] * ((CELL * s.prog) / s.len);
}

/** Feet y in world px; allocates nothing. */
export function feetY(s) {
  const ny = nodeY(s.bd, s.cell);
  if (s.mode === 'floor') return ny;
  if (s.mode === 'air') return ny + s.alt;
  return ny + DY[s.link] * ((CELL * s.prog) / s.len);
}

/** Feet position in world px. */
export function feet(s) {
  return [feetX(s), feetY(s)];
}

/** The boards the feet touch: the current one, and the far one while a link crosses a seam. */
function touchBoards(s) {
  return s.mode === 'link' && s.to.board !== s.bd ? [s.bd, s.to.board] : [s.bd];
}

function flameTouch(s) {
  const [fx, fy] = feet(s);
  for (const bd of touchBoards(s)) {
    for (const cell of s.world.flamesAt(bd.x, bd.y)) {
      const [x, y] = nodeXY(bd, cell);
      if (Math.abs(fx - x) <= TOUCH && Math.abs(fy - y) <= TOUCH) return true;
    }
  }
  return false;
}

/**
 * Takes each untaken coin the feet touch, dead-end or row, pushing 'coin' for
 * it. A coin stays taken while its tomb is one of the recent tombs.
 */
function coinTouch(s) {
  const [fx, fy] = feet(s);
  for (const bd of touchBoards(s)) {
    for (const { cell, kind } of floorItems(s.world, bd)) {
      if (kind !== 'coin') continue;
      const id = coinId(bd, cell);
      if (s.collected.has(id)) continue;
      const [x, y] = itemSpot(bd, cell);
      if (Math.abs(fx - x) <= TOUCH && Math.abs(fy - y) <= TOUCH) {
        s.collected.add(id);
        s.events.push('coin');
      }
    }
    for (const cell of coinRows(s.world, bd)) {
      for (let i = 0; i < ROW_COINS; i++) {
        const [x, y] = rowSpot(bd, cell, i);
        if (Math.abs(fx - x) > TOUCH || Math.abs(fy - y) > TOUCH) continue;
        const id = coinId(bd, cell, i);
        if (!s.collected.has(id)) {
          s.collected.add(id);
          s.events.push('coin');
        }
      }
    }
  }
}

/**
 * Takes each untaken oil jar the feet touch, while its tomb stays recent: burn
 * rises by JAR_S to at most BURN_S, an ember ends, and the event is a
 * brazier's. It runs ahead of the tick's own burn.
 */
function jarTouch(s) {
  const [fx, fy] = feet(s);
  for (const bd of touchBoards(s)) {
    for (const { cell, kind } of floorItems(s.world, bd)) {
      if (kind !== 'oil') continue;
      const id = coinId(bd, cell);
      if (s.jars.has(id)) continue;
      const [x, y] = itemSpot(bd, cell);
      if (Math.abs(fx - x) <= TOUCH && Math.abs(fy - y) <= TOUCH) {
        s.jars.add(id);
        s.events.push(s.burn < BURN_S * 0.98 || s.ember > 0 ? 'relight' : 'touch');
        s.burn = Math.min(BURN_S, s.burn + JAR_S);
        s.ember = 0;
      }
    }
  }
}

/** Records the one link or door that joins the cell the tick began on to the current cell. */
function recordMove(s, bd, cell) {
  for (let d = 0; d < 8; d++) {
    const to = s.world.step(bd, cell, d);
    if (to && to.board.x === s.bd.x && to.board.y === s.bd.y && to.cell === s.cell) { recordWalk(s.trail, bd, cell, d, to); return; }
  }
  recordStood(s.trail, s.bd, s.cell);
}

/**
 * Advances one tick with input h, v in {-1, 0, 1} (v > 0 is up). `jump` is
 * true when a jump key was pressed since the last tick; `edges` holds the
 * KEY bits pressed and released since then.
 */
export function step(s, h, v, jump = false, edges = NO_EDGES) {
  s.events.length = 0;
  if (s.state !== 'play') return s;
  const fromBd = s.bd, fromCell = s.cell;
  s.time += TICK;
  const dt = TICK + s.carry;
  s.carry = 0;
  if (s.buffer && --s.bufferTicks < 0) s.buffer = 0;
  readEdges(s, edges);
  if (jump && s.mode === 'floor') launch(s);
  else if (jump && s.mode === 'link' && s.link < 4) letGo(s);
  if (s.mode === 'floor') floorMove(s, h, v, dt);
  else if (s.mode === 'air') airMove(s, h, v, dt);
  else linkMove(s, h, v, dt);
  // Every path that changes the cell runs above; the trail follows the cell.
  if (s.bd !== fromBd || s.cell !== fromCell) recordMove(s, fromBd, fromCell);
  jarTouch(s);
  // Contact with a flame holds the torch at full; events fire once per contact.
  const touch = flameTouch(s);
  if (touch) {
    if (!s.touching) {
      s.stats.flames++;
      s.events.push(s.burn < BURN_S * 0.98 || s.ember > 0 ? 'relight' : 'touch');
    }
    s.burn = BURN_S;
    s.ember = 0;
  } else if (s.burn > 0) {
    s.burn -= TICK;
    if (s.burn <= 0) { s.burn = 0; s.ember = EMBER_S; s.events.push('ember'); }
  } else {
    s.ember -= TICK;
    if (s.ember <= 0) { s.ember = 0; s.state = 'over'; s.events.push('over'); }
  }
  s.touching = touch;
  coinTouch(s);
  return s;
}

/** Animation name and frame for the explorer. */
export function pose(s) {
  if (s.mode === 'air') return { anim: 'jump', frame: s.vy > 0 ? 0 : 1 };
  if (s.mode === 'link') {
    if (s.link < 4) return { anim: 'climb', frame: Math.floor(s.climbed / 8) % 4 };
    return { anim: 'gallery', frame: Math.floor(s.walked / 7) % 8 };
  }
  if (s.moving) return { anim: 'run', frame: Math.floor(s.walked / 6) % 8 };
  if (s.burn <= 0) return { anim: 'gasp', frame: Math.floor(s.time * 3) % 2 };
  return { anim: 'idle', frame: Math.floor(s.time * 4) % 4 };
}
