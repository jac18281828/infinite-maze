// Simulation: the explorer moves along the cell graph, so motion admits
// exactly the tree's links. A jump is an air state of the current cell: on
// the ground or in the air, the explorer leaves a cell only along a link or
// door. A let-go drops from a ladder over its lower cell. Runs on a fixed
// 60 Hz tick; no DOM.
import { DX, DY, BW } from '../world/board.mjs';

export const TICK = 1 / 60;
export const CELL = 48;
export const BOARD_W = 576;
export const BOARD_H = 336;
export const RUN_SPEED = 96;
export const GALLERY_SPEED = 72;
export const LADDER_SPEED = 48;
export const BURN_S = 300;
export const EMBER_S = 10;
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
  return [bd.x * BOARD_W + (cell % BW) * CELL + 24, bd.y * BOARD_H + ((cell / BW) | 0) * CELL + 8];
}

/** Light radius: 96 px full, falling linearly to 24 px at 10% burn. */
export function torchRadius(burn) {
  if (burn <= 0) return R_EMBER;
  const f = burn / BURN_S;
  return f <= 0.1 ? R_LOW : R_LOW + (R_FULL - R_LOW) * (f - 0.1) / 0.9;
}

/** Press and release edges, as KEY bits, between held inputs (h0, v0) and (h1, v1). */
export function inputEdges(h0, v0, h1, v1) {
  const bits = (h, v) => (h < 0 ? KEY.L : 0) | (h > 0 ? KEY.R : 0) | (v > 0 ? KEY.U : 0) | (v < 0 ? KEY.D : 0);
  const a = bits(h0, v0), b = bits(h1, v1);
  return { press: b & ~a, release: a & ~b };
}

/** A run from `start` = { board, cell }, standing on the door's cell. */
export function createSim(world, start, carry = null) {
  const s = {
    world, bd: start.board, cell: start.cell,
    mode: 'floor', off: 0, alt: 0, vy: 0, link: -1, to: null, prog: 0, len: 0,
    facing: 1, moving: false, burn: BURN_S, ember: 0,
    tap: 0, buffer: 0, bufferTicks: 0, queued: 0, dismount: 0, letGo: false,
    state: 'play', time: carry ? carry.time : 0,
    startBand: carry ? carry.startBand : start.board.band,
    maxBand: carry ? Math.max(carry.maxBand, start.board.band) : start.board.band,
    lastEntry: start.board.routeIndex === 0 ? start.board.p : (carry ? carry.lastEntry : start.board.p),
    touching: false, walked: 0, climbed: 0, carry: 0,
    stats: {
      corridor: 0, ladderUp: 0, seams: 0, flames: 0, jumps: 0, airGrabs: 0, stairLandings: 0, dismounts: 0, letGos: 0,
    },
    events: [],
  };
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

/** Reach toward side h: unbounded through a corridor or door, 0 at a gallery foot or mouth, else the wall. */
function sideLimit(s, h) {
  if (canGo(s, h > 0 ? 0 : 2)) return Infinity;
  return (h > 0 ? [4, 7] : [5, 6]).some((e) => canGo(s, e)) ? 0 : WALL_REACH;
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

function enterBoard(s, bd) {
  if (bd === s.bd) return;
  s.stats.seams++;
  s.events.push('seam');
  if (bd.band > s.maxBand) { s.maxBand = bd.band; s.events.push('band'); }
  if (bd.routeIndex === 0 && bd.p !== s.lastEntry) { s.lastEntry = bd.p; s.events.push('entry'); }
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
  if (press & KEY.U) s.letGo = false;
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
    const diags = (h > 0 ? [4, 7] : [5, 6]).filter((e) => canGo(s, e));
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
  // A link always ends at its node; unspent tick time carries to the next tick.
  if (s.prog >= s.len - 1e-9) {
    s.carry = (s.prog - s.len) / speed;
    if (d === 1) s.stats.ladderUp++;
    arrive(s);
  } else if (s.prog <= 1e-9) {
    s.carry = -s.prog / speed;
  } else return;
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
  s.letGo = true;
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
    // A head in the ladder shaft stays within it.
    if (s.alt > ROOM_CLEAR) lim = Math.min(lim, SHAFT_REACH);
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
    s.letGo = false;
    return;
  }
  if (v <= 0 || s.letGo || (stair && h === -stair)) return;
  if (k >= 0 && s.alt - land <= STAIR_REACH) {
    s.stats.airGrabs++;
    engage(s, up, k * Math.SQRT2);
  } else if (up === 1 && Math.abs(s.off) <= SHAFT_REACH) {
    s.stats.airGrabs++;
    engage(s, 1, s.alt);
  }
}

/** Feet position in world px. */
export function feet(s) {
  const [nx, ny] = nodeXY(s.bd, s.cell);
  if (s.mode === 'floor') return [nx + s.off, ny];
  if (s.mode === 'air') return [nx + s.off, ny + s.alt];
  const k = (CELL * s.prog) / s.len;
  return [nx + DX[s.link] * k, ny + DY[s.link] * k];
}

function flameTouch(s) {
  const [fx, fy] = feet(s);
  const boards = s.mode === 'link' && s.to.board !== s.bd ? [s.bd, s.to.board] : [s.bd];
  for (const bd of boards) {
    for (const cell of s.world.flamesAt(bd.x, bd.y)) {
      const [x, y] = nodeXY(bd, cell);
      if (Math.abs(fx - x) <= TOUCH && Math.abs(fy - y) <= TOUCH) return true;
    }
  }
  return false;
}

/**
 * Advances one tick with input h, v in {-1, 0, 1} (v > 0 is up). `jump` is
 * true when a jump key was pressed since the last tick; `edges` holds the
 * KEY bits pressed and released since then.
 */
export function step(s, h, v, jump = false, edges = NO_EDGES) {
  s.events.length = 0;
  if (s.state !== 'play') return s;
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
