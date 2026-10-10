// Simulation: the explorer moves along the cell graph, so motion admits
// exactly the tree's links. Runs on a fixed 60 Hz tick; no DOM.
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
// Floor reach from the cell centre toward a wall: interior half-width 16
// less the explorer's half-width 5.
const WALL_REACH = 11;
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

function diagFor(h, v) {
  if (v > 0) return h > 0 ? 4 : 5;
  return h > 0 ? 7 : 6;
}

/** A run from `start` = { board, cell }, standing on the door's cell. */
export function createSim(world, start, carry = null) {
  const s = {
    world, bd: start.board, cell: start.cell,
    mode: 'floor', off: 0, link: -1, to: null, prog: 0, len: 0,
    facing: 1, moving: false, burn: BURN_S, ember: 0,
    state: 'play', time: carry ? carry.time : 0,
    startBand: carry ? carry.startBand : start.board.band,
    maxBand: carry ? Math.max(carry.maxBand, start.board.band) : start.board.band,
    lastEntry: start.board.routeIndex === 0 ? start.board.p : (carry ? carry.lastEntry : start.board.p),
    touching: false, walked: 0, climbed: 0, carry: 0,
    stats: { corridor: 0, ladderUp: 0, seams: 0, flames: 0 },
    events: [],
  };
  return s;
}

export function canGo(s, d) {
  return !!s.world.step(s.bd, s.cell, d);
}

/** The ladder or gallery that input (h, v) asks for at the current cell. */
function pickLink(s, h, v) {
  if (v === 0) return -1;
  if (h !== 0 && canGo(s, diagFor(h, v))) return diagFor(h, v);
  const vert = v > 0 ? 1 : 3;
  if (canGo(s, vert)) return vert;
  if (h !== 0) return -1;
  const diags = (v > 0 ? [4, 5] : [7, 6]).filter((d) => canGo(s, d));
  return diags.length === 1 ? diags[0] : -1;
}

function engage(s, d, prog = 0) {
  s.mode = 'link';
  s.link = d;
  s.to = s.world.step(s.bd, s.cell, d);
  s.len = d < 4 ? CELL : CELL * Math.SQRT2;
  s.prog = prog;
  s.off = 0;
}

function enterBoard(s, bd) {
  if (bd === s.bd) return;
  s.stats.seams++;
  s.events.push('seam');
  if (bd.band > s.maxBand) { s.maxBand = bd.band; s.events.push('band'); }
  if (bd.routeIndex === 0 && bd.p !== s.lastEntry) { s.lastEntry = bd.p; s.events.push('entry'); }
}

function floorMove(s, h, v, dt) {
  const d = pickLink(s, h, v);
  const stepPx = RUN_SPEED * dt;
  if (d >= 0) {
    if (Math.abs(s.off) > stepPx) {
      const dir = -Math.sign(s.off);
      s.off += dir * stepPx;
      s.facing = dir;
      s.moving = true;
      s.walked += stepPx;
      return;
    }
    const used = Math.abs(s.off) / RUN_SPEED;
    s.walked += Math.abs(s.off);
    engage(s, d);
    if (DX[d]) s.facing = DX[d];
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
    // A gallery foot or mouth on this side leaves no floor past the centre.
    const lim = diags.length ? 0 : WALL_REACH;
    if (next * h > lim) next = Math.max(s.off * h, lim) * h;
  }
  s.moving = next !== s.off;
  s.walked += Math.abs(next - s.off);
  s.off = next;
  if (s.off * h > CELL / 2) {
    const nb = s.world.step(s.bd, s.cell, hd);
    enterBoard(s, nb.board);
    s.bd = nb.board;
    s.cell = nb.cell;
    s.off -= h * CELL;
    s.stats.corridor++;
  }
}

function linkMove(s, h, v, dt) {
  const d = s.link;
  const along = d === 1 || d === 3 ? v * DY[d] : Math.sign(h * DX[d] + v * DY[d]);
  if (along === 0) { s.moving = false; return; }
  const speed = d < 4 ? LADDER_SPEED : GALLERY_SPEED;
  s.prog += along * speed * dt;
  s.moving = true;
  if (d < 4) s.climbed += speed * dt;
  else { s.walked += speed * dt; s.facing = DX[d] * along; }
  // A link always ends at its node; unspent tick time carries to the next tick.
  if (s.prog >= s.len - 1e-9) {
    s.carry = Math.max(0, s.prog - s.len) / speed;
    if (d === 1) s.stats.ladderUp++;
    enterBoard(s, s.to.board);
    s.bd = s.to.board;
    s.cell = s.to.cell;
    s.mode = 'floor';
    s.off = 0;
  } else if (s.prog <= 1e-9) {
    s.carry = Math.max(0, -s.prog) / speed;
    s.mode = 'floor';
    s.off = 0;
  }
}

/** Feet position in world px. */
export function feet(s) {
  const [nx, ny] = nodeXY(s.bd, s.cell);
  if (s.mode === 'floor') return [nx + s.off, ny];
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

/** Advances one tick with input h, v in {-1, 0, 1} (v > 0 is up). */
export function step(s, h, v) {
  s.events.length = 0;
  if (s.state !== 'play') return s;
  s.time += TICK;
  const dt = TICK + s.carry;
  s.carry = 0;
  if (s.mode === 'floor') floorMove(s, h, v, dt);
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
  if (s.mode === 'link') {
    if (s.link < 4) return { anim: 'climb', frame: Math.floor(s.climbed / 8) % 4 };
    return { anim: 'gallery', frame: Math.floor(s.walked / 7) % 8 };
  }
  if (s.moving) return { anim: 'run', frame: Math.floor(s.walked / 6) % 8 };
  if (s.burn <= 0) return { anim: 'gasp', frame: Math.floor(s.time * 3) % 2 };
  return { anim: 'idle', frame: Math.floor(s.time * 4) % 4 };
}
