// Boot, input, the fixed 60 Hz loop and the slot list, NEW RUN, play, SAVE IN?,
// pause, end and milestone splash screens. `#selftest` in the URL runs the
// self-test instead.
import { createWorld, boardOfPos, boardCoords } from '../world/world.mjs';
import { DIFFICULTY, DIFFICULTIES } from '../world/band.mjs';
import { parseCode, formatCode, codeFromBytes } from '../world/hash.mjs';
import { encodeSave, decodeSave } from '../world/save.mjs';
import { floorItems, itemSpot, coinRows, rowSpot } from '../world/floor.mjs';
import {
  createSim, step, runCarry, TICK, BURN_S, KEY, feet, pose, nodeXY, tombCount, inputEdges, createTrail,
} from './sim.mjs';
import { snapCam, followCam, createFrame, placeFrame, deviceX, deviceY } from './camera.mjs';
import { createRenderer, VIEW_W, VIEW_H, MAP_SCALE, shade, spriteCanvas } from './render.mjs';
import { createAudio } from './audio.mjs';
import { runScript, createAutopilot, SELFTEST_CODE } from './autopilot.mjs';
import {
  OLD_SLOT_KEY, LEGACY_KEYS, COIN_RATE, coinKey, coinId, newSlotId, packRecent, unpackRecent,
  SAVE_SLOTS, MIGRATED_KEY, saveKey, parseSave, serializeSave, risePay, commitSave, takeSave, eraseSave, migrateSaves,
} from './wallet.mjs';
import { createGamepad } from './gamepad.mjs';
import { createTouch, layout, viewport, difficultyLabel, padSide, titleFeet, PANEL_X, textWidth } from './touch.mjs';
import { MILESTONE, rankName } from './ranks.mjs';
import { copyWithStatus, saveLabel } from './clipboard.mjs';
import { createGuard, errorLine } from './loop.mjs';
import { createStorage } from './storage.mjs';
import { frameOf, panFrame, sameFrame, mapModel, mapCells } from './map.mjs';
import { RGB, idx, PALETTE, COIN, FONT_W } from './art.mjs';

// The bests of the tomb plane keep a key of their own, so a stacked-world value
// never reads as a score. The saves live under saveKey(n) (wallet.mjs).
// The title's difficulty setting; absent means MEDIUM.
const KEY_DIFFICULTY = 'infinite-maze.difficulty';
// The d-pad's side, 'left' or 'right'; anything else reads 'left'.
const KEY_PAD = 'infinite-maze.pad';
const KEY_BEST = 'infinite-maze.plane.best';
// A save code runs to 26 characters: 10 for the seed and up to 16 digits of p.
const TYPED_MAX = 26;

const SELFTEST = location.hash === '#selftest';
// The self-test keeps its storage in memory for the page's lifetime, so it
// never reads or writes the player's wallet, saves or settings.
const memory = SELFTEST ? new Map() : null;

const memoryArea = memory && {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};
// Every storage access is guarded; the game runs without storage.
const storage = createStorage(() => memoryArea || globalThis.localStorage);
const { load, store, unstore } = storage;

/** The real localStorage's save, marker, old slot and legacy keys, as stored, for the self-test's guard. */
function realKeys() {
  return [...SAVE_SLOTS.map(saveKey), MIGRATED_KEY, OLD_SLOT_KEY, ...Object.values(LEGACY_KEYS)].map((k) => {
    try { return globalThis.localStorage.getItem(k); } catch { return null; }
  });
}
const realAtStart = SELFTEST ? realKeys() : null;
const realUntouched = () => realKeys().every((v, i) => v === realAtStart[i]);

const display = document.getElementById('screen');
const dctx = display.getContext('2d');
// The overlay: the HUD and the screens at whole game px, over the scene.
const view = document.createElement('canvas');
view.width = VIEW_W;
view.height = VIEW_H;

// Set by `boot`; null before it runs and in the self-test's first phase.
let touch = null;

/** Sizes and places the display canvas by the layout for the current input mode. */
function fit() {
  const lay = touch ? touch.relayout() : layout({ ...viewport(), touch: false });
  display.width = lay.backing.w;
  display.height = lay.backing.h;
  const s = display.style;
  s.left = `${lay.view.x}px`;
  s.top = `${lay.view.y}px`;
  s.width = `${lay.view.w}px`;
  s.height = `${lay.view.h}px`;
}

/** The difficulty stored under `key`, or `fallback` when absent or invalid. */
function storedDifficulty(key, fallback) {
  const d = load(key);
  return DIFFICULTIES.includes(d) ? d : fallback;
}

// Each save key as last parsed, keyed by the raw text it came from: the slot
// list reads all three every frame.
const parsedSaves = SAVE_SLOTS.map(() => ({ raw: undefined, held: null }));

/** Slot n's key in one of its four states (parseSave). Callers never change the result. */
function heldSave(n) {
  const raw = load(saveKey(n)), c = parsedSaves[n - 1];
  if (c.raw !== raw) {
    c.raw = raw;
    c.held = parseSave(raw);
  }
  return c.held;
}

/** True for a key a run takes without asking: absent or damaged. */
const isFree = (held) => held.state === 'absent' || held.state === 'damaged';

/** True while ERASE shows: no slot empty or damaged, and one at least used. */
function eraseShows() {
  let used = false;
  for (const n of SAVE_SLOTS) {
    const held = heldSave(n);
    if (isFree(held)) return false;
    if (held.state === 'valid') used = true;
  }
  return used;
}

/** The used slots in row order, as digits: the rows erasing visits. */
function usedRows() {
  let out = '';
  for (const n of SAVE_SLOTS) if (heldSave(n).state === 'valid') out += n;
  return out;
}

// What a slot row reads when it holds no record this build can play.
const ROW_LABEL = { absent: 'EMPTY', damaged: 'DAMAGED', newer: 'NEWER' };

const slotIo = { load, store, remove: unstore };

/** Where the record pairs sim save point `at`, { p, net }: the serial of its board, the net there and the run's start tomb. */
function pointOf(g, at) {
  const { x, y } = boardOfPos(at.p), { u, v } = g.sim.start;
  return { save: encodeSave(g.code, x, y), net: at.net, start: `${u},${v}` };
}

/**
 * The run's record at `point`. A dead run writes the count any continuation
 * of it carries: its own plus one. Every record carries the takes of the
 * run's recent tombs.
 */
function runState(g, point) {
  const { high, continues, state } = g.sim;
  return {
    id: g.saveId, save: point.save, level: g.world.difficulty, start: point.start, net: point.net, high,
    wallet: g.wallet, continues: state === 'over' ? continues + 1 : continues, recent: packRecent(g.world, g.sim),
  };
}

/** The run plays on unsaved: no slot and no save, and its next coin or counted tomb asks SAVE IN? again. */
function unbind(g) {
  Object.assign(g, { slot: null, saveId: null, point: null, asked: false });
}

/** An unsaved run's pay, in memory: the tick's `coins` and the rise of the high over `was`. */
function payInMemory(g, coins, was) {
  const earned = coins + risePay(g.world.difficulty, was, tombCount(g.sim));
  g.wallet += earned;
  return { ok: false, earned, seen: was };
}

/**
 * Writes the run's record at `point` to its slot, paying the tick's `coins`
 * and the rise of the high over `was`, and returns the write's result with
 * the pay's `earned` and `seen`. A run holding no save takes its slot: a free
 * one, or with `over` the record OVERWRITE drew. A run holding a save writes
 * it only while the slot holds that save. A write that finds anything else
 * stores nothing and leaves the run unsaved, paid in memory. A live run adopts
 * the merged continue count; a dead run keeps its own, so every write on one
 * death stores one rise.
 */
function commit(g, point, { coins = 0, was = tombCount(g.sim), over = null } = {}) {
  const key = saveKey(g.slot), run = runState(g, point), pay = { coins, paid: was };
  const out = g.saveId === null ? takeSave(slotIo, key, { ...run, id: newSlotId() }, { ...pay, over }) : commitSave(slotIo, key, run, pay);
  if (!out.ok) {
    unbind(g);
    return { ...payInMemory(g, coins, was), held: out.held };
  }
  g.saveId = out.record.id;
  g.point = point;
  g.wallet = out.record.wallet;
  g.sim.high = out.record.high;
  if (g.sim.state !== 'over') g.sim.continues = out.record.continues;
  return out;
}

/**
 * The one writer that moves the run's serial. Save point `at` is one value
 * holding a board and the net there, so no write pairs a serial with another
 * moment's net. A run holding no save writes only to take its slot (`bind`,
 * with `over` for OVERWRITE); before then it writes nothing.
 */
function writeAt(g, at, { bind = null, coins = 0, was = tombCount(g.sim) } = {}) {
  if (g.saveId === null && bind === null) return null;
  return commit(g, pointOf(g, at), { coins, was, over: bind && bind.over ? bind.over : null });
}

/** Draws the overlay over the display at whole game px. */
function drawOverlay() {
  dctx.imageSmoothingEnabled = false;
  dctx.drawImage(view, 0, 0, display.width, display.height);
}

/** Composites renderer `r`'s scene onto the display, then the overlay over it. */
function present(r) {
  r.composite();
  drawOverlay();
}

function rollCode() {
  const b = new Uint8Array(5);
  globalThis.crypto.getRandomValues(b);
  return codeFromBytes(b);
}

function clock(s) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function selftest() {
  const errors = [];
  window.onerror = (msg) => { errors.push(String(msg)); };
  window.addEventListener('unhandledrejection', (e) => { errors.push(`rejection: ${e.reason}`); });
  const finish = (verdict) => { document.body.dataset.selftest = verdict; };
  try {
    const world = createWorld(SELFTEST_CODE);
    const { sim, reason } = runScript(world);
    if (reason) { finish(`fail: ${reason}`); return; }
    fit();
    const r = createRenderer(view, world, display);
    const cam = { x: 0, y: 0 };
    snapCam(cam, sim);
    r.scene(sim, cam, 0);
    r.hud(sim);
    // Draws an unsaved run's pause screen over the scene, so a draw-time error fails the gate.
    drawPause({
      renderer: r, world, sim, code: SELFTEST_CODE, saveId: null, copied: '', audio: { muted: false },
      frame: frameOf(sim.bd, world.size), pauseMap: null, pausedAt: null,
    });
    present(r);
    const px = dctx.getImageData(0, 0, display.width, display.height).data;
    const colours = new Set();
    for (let i = 0; i < px.length && colours.size < 2; i += 4) colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (colours.size < 2) { finish('fail: canvas holds one colour'); return; }
    // The game's default level, MEDIUM, whose tomb (1, 0) starts at column 3.
    planeLeg(createWorld(SELFTEST_CODE, { difficulty: 'medium' }));
    touchLeg();
    if (!realUntouched()) throw new Error('touch the self-test leaves the real wallet untouched');
    // The verdict waits one task, so queued error and rejection events count.
    setTimeout(() => finish(errors.length ? `fail: ${errors[0]}` : 'pass'), 0);
  } catch (e) {
    finish(`fail: ${e && e.message ? e.message : e}`);
  }
}

/**
 * Resumes at the first entry of tomb (1, 0), whose boards lie outside
 * columns 0 to W - 1, and throws unless the frame draws the explorer's room
 * as maze: its pixels must differ from the same frame drawn with the
 * explorer's board as rock. The explorer stands on its first primary cell,
 * which the carve keeps. Touches no storage and never boots.
 */
function planeLeg(world) {
  const t = world.tomb(1, 0);
  const at = boardCoords(1, 0, t.entries[0], world.size);
  const sim = createSim(world, world.resumePoint(at.x, at.y));
  const w = world.size.w;
  if (sim.bd.x < w) throw new Error(`plane leg: board (${sim.bd.x},${sim.bd.y}) lies in columns 0-${w - 1}`);
  const cam = { x: 0, y: 0 };
  snapCam(cam, sim);
  // The inner 28x28 px of the explorer's 32 px room, on the display.
  const [nx, ny] = nodeXY(sim.bd, sim.cell);
  const f = createFrame();
  placeFrame(f, cam, display.width, display.height, VIEW_W, VIEW_H);
  const x0 = Math.round(deviceX(f, nx - 14)), x1 = Math.round(deviceX(f, nx + 14));
  const y0 = Math.round(deviceY(f, ny + 30)), y1 = Math.round(deviceY(f, ny + 2));
  const room = (wd) => {
    const r = createRenderer(view, wd, display);
    r.scene(sim, cam, 0);
    r.composite();
    return dctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  };
  const rockBoard = { ...sim.bd, kind: 'rock', links: null, doors: [], doorMask: null };
  const maze = room(world);
  const rock = room({ ...world, board: (x, y) => (x === sim.bd.x && y === sim.bd.y ? rockBoard : world.board(x, y)) });
  if (maze.every((v, i) => v === rock[i])) throw new Error(`plane leg: board (${at.x},${at.y}) draws as rock`);
}

/**
 * Stands a standard gamepad in for `navigator.getGamepads` as an own property;
 * the caller deletes it. The leg sets `fake.held`, the pressed buttons. Each
 * call returns fresh objects and throws unless called as a method of
 * navigator, as a browser's does.
 */
function fakeGamepads(fake) {
  Object.defineProperty(navigator, 'getGamepads', {
    value() {
      if (this !== navigator) throw new TypeError('Illegal invocation');
      return [{ mapping: 'standard', buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: fake.held.has(i) })), axes: [0, 0, 0, 0] }];
    },
    configurable: true,
  });
}

/**
 * Boots the game and drives the real controls with dispatched touch pointer
 * events and clicks. One synchronous task: an animation frame landing
 * mid-leg would tick play and clear the press edges the leg reads. Throws
 * `touch <what>` on the first miss.
 */
function touchLeg() {
  // COPY writes through a fake clipboard, gone again however the leg ends.
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  const fake = { held: new Set() };
  fakeGamepads(fake);
  try {
    driveTouch(copied, fake);
  } finally {
    delete navigator.clipboard;
    delete navigator.getGamepads;
  }
  if (Object.getOwnPropertyDescriptor(navigator, 'clipboard')) throw new Error('touch clipboard restored');
  if (Object.getOwnPropertyDescriptor(navigator, 'getGamepads')) throw new Error('touch getGamepads restored');
}

/** `copied` records each clipboard write; writeText runs within the click. `fake.held` holds the fake gamepad's pressed buttons. */
function driveTouch(copied, fake) {
  const need = (ok, what) => { if (!ok) throw new Error(`touch ${what}`); };
  // Boot reads the player's setting; with none stored, a new player starts at MEDIUM.
  unstore(KEY_DIFFICULTY);
  // Slot 1 holds 300 coins and TOMB 20, which boot leaves alone; slots 2 and 3 are empty.
  clearSaves();
  putSave(1, { wallet: 300, net: 20, high: 20 });
  // Boot reads the pad's side.
  store(KEY_PAD, 'right');
  const g = boot();
  need(isClean(g), 'boot starts clean');
  need(g.code === 'K7Q2M9XA' && saveNow(1).wallet === 300, 'the title shows the slot\'s seed and boot leaves the slot');
  need(g.difficulty === 'medium' && g.world.difficulty === 'medium', 'a new player starts at MEDIUM');
  need(touch && !touch.on, 'starts in keyboard mode');
  need(touch.soft('title', 'new').getBoundingClientRect().width === 0, 'controls hidden in keyboard mode');
  // A dispatched click fires on a hidden button, so a control must have a box first.
  const live = (el, what) => {
    const r = el.getBoundingClientRect();
    need(r.width > 0 && r.height > 0, `${what} is shown`);
    return r;
  };
  const click = (sid, id) => { const el = touch.soft(sid, id); live(el, `${sid}/${id}`); el.click(); };
  const pointer = (type, el, x, y) => el.dispatchEvent(new PointerEvent(type, {
    pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
  const press = (code, key, repeat = false) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key, repeat, bubbles: true, cancelable: true }));
  const copies = (sid, want) => {
    copied.length = 0;
    click(sid, 'copy');
    need(copied.length === 1 && copied[0] === want, `${sid} COPY writes ${want}`);
  };
  // Another tree board of the explorer's tomb, keeping its last entry, so the
  // pause screen's save code and the end screen's entry code differ.
  const offEntry = () => {
    const s = g.sim;
    const carry = runCarry(s);
    const { w, h } = g.world.size;
    for (let i = 0; i < w * h; i++) {
      const { x, y } = boardCoords(s.bd.u, s.bd.v, i, g.world.size);
      const bd = g.world.board(x, y);
      if (!bd.links || bd.entry || bd === s.bd || bd.p === s.lastEntry) continue;
      g.sim = createSim(g.world, g.world.resumePoint(bd.x, bd.y), carry);
      break;
    }
    need(hereCode(g) !== entryCode(g), 'the explorer is off its entry board');
  };
  const toggles = (sid) => {
    const was = g.audio.muted;
    click(sid, 'sound');
    need(g.audio.muted !== was, `${sid} SOUND toggles mute`);
    click(sid, 'sound');
    need(g.audio.muted === was, `${sid} SOUND toggles back`);
  };
  // Dispatched touches carry no native click: a lift the zoom guard leaves
  // alone clicks nothing, and one it cancels clicks its key itself.
  let touchId = 0;
  const touchTap = (el, start, end, liftOn = el) => {
    const r = live(liftOn, 'tapped element');
    const t = { identifier: ++touchId, target: el, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const fire = (type, at) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'timeStamp', { value: at });
      Object.defineProperty(ev, 'changedTouches', { value: [t] });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    fire('touchstart', start);
    return fire('touchend', end);
  };

  // Mode switch and canvas size.
  pointer('pointerdown', display, 10, 10);
  need(touch.on, 'a touch pointerdown turns touch mode on');
  live(touch.soft('title', 'new'), 'title/new');
  const lay = layout({ ...viewport(), touch: true });
  // The preview's feet as the scene draws them, in view px.
  const [fx, fy] = feet(g.preview), [wantX, wantY] = titleFeet(lay);
  const f = createFrame();
  placeFrame(f, g.cam, display.width, display.height, VIEW_W, VIEW_H);
  need(Math.abs(deviceX(f, fx) / f.sx - wantX) <= 1 && Math.abs(deviceY(f, fy) / f.sy - wantY) <= 1,
    'the title explorer stands at its spot');
  need(display.width === lay.backing.w && display.height === lay.backing.h, 'canvas backing size follows the layout');
  // Layout rounds to 1/64 CSS px, so the laid-out box matches within that.
  const box = display.getBoundingClientRect();
  need(Math.abs(box.width - lay.view.w) <= 1 / 64 && Math.abs(box.height - lay.view.h) <= 1 / 64, 'canvas CSS size follows the layout');

  // The slot list: its cursor starts on the first used slot, ERASE stays hidden while a slot is empty, and
  // RESUME with no run open.
  need(g.screen === 'title' && g.cursor === 0, 'the slot list\'s cursor starts on the first used slot');
  for (const id of ['s1', 's2', 's3', 'new']) live(touch.soft('title', id), `title/${id}`);
  need(touch.soft('title', 'erase').getBoundingClientRect().width === 0 && touch.soft('title', 'resume').getBoundingClientRect().width === 0,
    'the slot list hides ERASE beside an empty slot and RESUME with no run open');
  click('title', 'new');
  need(g.screen === 'newrun' && g.bind === null, 'NEW RUN opens unbound from the NEW RUN key');

  // NEW RUN.
  const rolled = g.code;
  click('newrun', 'seed');
  need(g.code !== rolled, 'NEW SEED changes the code');
  withPrompt('K7Q2-M9XA', () => {
    click('newrun', 'type');
    need(g.code === 'K7Q2M9XA' && g.typing === null, 'TYPE CODE takes the answer');
  });
  withPrompt(null, () => {
    click('newrun', 'type');
    need(g.code === 'K7Q2M9XA' && g.typing === null, 'TYPE CODE cancel keeps the code and closes typing');
  });

  // Typing.
  press('KeyT', 't');
  draw(g, 0);
  need(g.typing !== null, 'KeyT opens typing');
  press('KeyP', 'p');
  need(g.screen === 'newrun' && g.typing === 'P', 'P types a letter in the code field');
  const side = g.side;
  press('KeyH', 'h');
  need(g.typing === 'PH' && g.side === side, 'H types a letter in the code field');
  click('typing', 'cancel');
  need(g.typing === null, 'CANCEL closes typing');
  press('KeyT', 't');
  for (const ch of '7ZZ0-1111') press(/[0-9]/.test(ch) ? `Digit${ch}` : ch === '-' ? 'Minus' : `Key${ch}`, ch);
  draw(g, 0);
  click('typing', 'accept');
  need(g.code === '7ZZ01111' && g.typing === null, 'ACCEPT takes the typed code');

  // Play.
  click('newrun', 'begin');
  need(g.screen === 'play', 'BEGIN reaches play');
  const pad = touch.padEl;
  const r = live(pad, 'pad');
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2, d = r.width / 3;
  // The placed controls say which side the pad stands on: its centre minus the fire button's.
  const padOffset = () => {
    const p = live(touch.padEl, 'pad'), f = live(touch.fireEl, 'fire');
    return p.left + p.width / 2 - (f.left + f.width / 2);
  };
  need(padOffset() > 0, 'boot reads the stored pad side');
  pointer('pointerdown', pad, cx + d, cy);
  pointer('pointercancel', pad, cx + d, cy);
  need(!g.keys.has('r') && (g.release & KEY.R) !== 0, 'pointercancel releases Right');
  g.press = 0;
  g.release = 0;
  pointer('pointerdown', pad, cx + d, cy);
  need(g.keys.has('r') && (g.press & KEY.R) !== 0, 'the right arm holds Right');
  pointer('pointermove', pad, cx, cy - d);
  need(!g.keys.has('r') && (g.release & KEY.R) !== 0 && g.keys.has('u') && (g.press & KEY.U) !== 0, 'sliding to the up arm swaps Right for Up');
  pointer('pointerup', pad, cx, cy - d);
  need(!g.keys.has('u') && (g.release & KEY.U) !== 0, 'lifting releases Up');
  pointer('pointerdown', pad, cx, cy);
  need(!g.jump && g.keys.size === 0, 'the centre holds nothing');
  pointer('pointerup', pad, cx, cy);
  const fr = live(touch.fireEl, 'fire');
  pointer('pointerdown', touch.fireEl, fr.left + fr.width / 2, fr.top + fr.height / 2);
  need(g.jump, 'FIRE jumps');
  pointer('pointerup', touch.fireEl, fr.left + fr.width / 2, fr.top + fr.height / 2);
  g.press = 0;
  g.release = 0;
  g.jump = false;

  // Pause.
  offEntry();
  click('play', 'pause');
  need(g.screen === 'pause', 'PAUSE reaches pause');
  const home = frameOf(g.sim.bd, g.world.size);
  const framed = (du, dv) => sameFrame(g.frame, { u: home.u + du, v: home.v + dv });
  need(framed(0, 0), 'PAUSE frames the explorer\'s tomb');
  press('ArrowUp', 'ArrowUp');
  need(framed(0, 1), 'Up pans one tomb up');
  press('ArrowUp', 'ArrowUp', true);
  need(framed(0, 1), 'a held Up pans nothing');
  press('ArrowLeft', 'ArrowLeft');
  need(framed(-1, 1), 'Left pans one tomb left');
  press('KeyD', 'd');
  press('KeyS', 's');
  need(framed(0, 0), 'D and S pan one tomb right and down');
  toggles('pause');
  const sound = touch.soft('pause', 'sound'), soundArt = sound.querySelector('canvas'), muted = g.audio.muted;
  need(!touchTap(display, 1000, 1100), 'a lone tap on the view is left to the browser');
  need(touchTap(display, 1400, 1900), 'a tap starting 300 ms after a lift is cancelled, however long it is held');
  need(!touchTap(soundArt, 3000, 3100) && g.audio.muted === muted, 'a lone tap on a key is left to the browser');
  need(touchTap(soundArt, 3400, 3500) && g.audio.muted !== muted, 'a quick second tap on a key is cancelled and clicks it');
  need(touchTap(soundArt, 3800, 3900, display) && g.audio.muted !== muted, 'a quick second tap lifted off its key clicks nothing');
  click('pause', 'sound');
  copies('pause', hereCode(g));
  // H swaps the pad's side on pause and ignores a repeat; PAD does what H does.
  const sideNow = g.side;
  press('KeyH', 'h', true);
  need(g.side === sideNow && load(KEY_PAD) === sideNow, 'pause ignores an auto-repeated H');
  click('pause', 'pad');
  const before = pauseModel(g).explorer;
  // A pan before RESUME must not outlast the pause.
  press('ArrowUp', 'ArrowUp');
  click('pause', 'resume');
  need(g.screen === 'play', 'RESUME returns to play');
  // Walk to another cell of the tomb, so a map kept from the last pause shows the old one.
  const frame = frameOf(g.sim.bd, g.world.size), cell = g.sim.cell, bd = g.sim.bd;
  for (const [h, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let i = 0; i < 600 && g.sim.cell === cell && g.sim.bd === bd; i++) step(g.sim, h, v);
    if (g.sim.cell !== cell || g.sim.bd !== bd) break;
  }
  need(sameFrame(frameOf(g.sim.bd, g.world.size), frame) && (g.sim.cell !== cell || g.sim.bd !== bd), 'the explorer walks to another cell of its tomb');
  // A torch and clock that a rebuild from the save would reset.
  const run = g.sim, runWorld = g.world, runCode = g.code;
  run.burn = BURN_S / 2;
  run.time = 77;
  click('play', 'pause');
  need(sameFrame(g.frame, frameOf(g.sim.bd, g.world.size)), 'PAUSE frames the explorer\'s tomb again');
  const after = pauseModel(g).explorer;
  need(after && (!before || after.col !== before.col || after.row !== before.row), 'PAUSE draws the explorer where it now stands');
  click('pause', 'title');
  need(g.screen === 'title', 'TITLE reaches the title');

  // Resume the open run: NEW RUN's keys change only the title's preview.
  click('title', 'new');
  click('newrun', 'difficulty');
  need(g.world !== runWorld && g.difficulty !== runWorld.difficulty, 'the difficulty key rebuilds the preview');
  click('newrun', 'seed');
  need(g.code !== runCode, 'NEW SEED changes the preview\'s seed');
  click('newrun', 'back');
  need(g.screen === 'title' && g.bind === null, 'BACK returns from NEW RUN to the slot list');
  click('title', 'resume');
  need(g.confirm === null, 'RESUME of an open run continues without asking');
  need(g.screen === 'play' && g.sim === run && g.world === runWorld && g.code === runCode, 'pause, TITLE and RESUME return to the same run');
  need(run.burn === BURN_S / 2 && run.time === 77, 'the resumed run keeps its torch and time');
  need(g.difficulty === runWorld.difficulty, 'RESUME moves the setting to the run\'s');
  need(load(KEY_PAD) === 'left' && padOffset() < 0, 'PAD stores the side and mirrors the layout');

  // P pauses and resumes; Esc does the same as the alias.
  press('KeyP', 'p');
  need(g.screen === 'pause', 'P pauses in play');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim === run, 'P resumes from pause');
  press('Escape', 'Escape');
  need(g.screen === 'pause', 'Esc still pauses in play');
  press('Escape', 'Escape');
  need(g.screen === 'play' && g.sim === run, 'Esc still resumes from pause');
  // A pause drawn, then a resume and a second P: the pause map's clock starts over.
  press('KeyP', 'p');
  draw(g, 0.25);
  need(g.pausedAt === 0.25, 'a drawn pause stamps its clock');
  press('KeyP', 'p');
  press('KeyP', 'p');
  need(g.screen === 'pause' && g.pausedAt === null, 'a second pause restarts the pause map clock');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim === run, 'P resumes from the second pause');
  for (const [code, key, name] of [['KeyP', 'p', 'P'], ['Escape', 'Escape', 'Esc']]) {
    draw(g, 0);
    click('play', 'pause');
    click('pause', 'title');
    need(g.screen === 'title', `TITLE reaches the title before ${name}`);
    press(code, key);
    need(g.screen === 'play' && g.sim === run && g.world === runWorld && g.code === runCode, `${name} on the title returns to the open run`);
  }

  // End screen.
  offEntry();
  endRun(g);
  draw(g, 0);
  press('KeyP', 'p');
  need(g.screen === 'over', 'P on the end screen leaves it showing');
  copies('over', entryCode(g));
  const trail = g.sim.trail;
  click('over', 'continue');
  need(g.screen === 'play', 'the end screen CONTINUE reaches play');
  need(g.sim.trail === trail, 'CONTINUE keeps the trail');
  endRun(g);
  draw(g, 0);
  click('over', 'title');
  need(g.screen === 'title', 'the end screen TITLE reaches the title');

  // Each flow's leg runs before any later leg that leans on its rule, so a rule broken fails in its own leg.
  const legs = { need, click, press, offEntry };
  emptyRowLeg(g, legs);
  difficultyLeg(g, legs);
  coinLeg(g, legs);
  twoGamesLeg(g, legs);
  splashLeg(g, legs);
  resumeLeg(g, legs);
  continueLeg(g, legs);
  otherTabLeg(g, legs);
  saveInLeg(g, legs);
  eraseLeg(g, legs);
  rereadLeg(g, legs);
  farmLeg(g, legs);
  damagedLeg(g, legs);
  newerLeg(g, legs);
  restoreLeg(g, legs);
  legacyLeg(g, legs);
  oilLeg(g, legs);
  gamepadLeg(g, { ...legs, fake });

  // Leave the self-test script's run paused on screen for the screenshot,
  // in the 6x4 world the script was written for.
  cleanState(g);
  setDifficulty(g, 'ultimate');
  useCode(g, SELFTEST_CODE);
  g.sim = runScript(g.world).sim;
  snapCam(g.cam, g.sim);
  g.screen = 'play';
  g.keys.clear();
  press('Escape', 'Escape');
  need(g.screen === 'pause' && sameFrame(g.frame, frameOf(g.sim.bd, g.world.size)), 'Esc pauses on the explorer\'s tomb');
  // The first pause frame lands half a second into the page and shows the explorer's dot.
  draw(g, 0.5);
  const e = pauseModel(g).explorer, o = mapOrigin(g.world);
  // Every level centres in ULTIMATE's 72x28-cell frame: EASY's 24 columns from x 124.
  need(o.x === 52 && mapOrigin({ size: DIFFICULTY.easy }).x === 124, 'the pause map centres in ULTIMATE\'s 72x28-cell frame');
  const dot = view.getContext('2d').getImageData(o.x + e.col * MAP_SCALE + 1, o.y + (o.rows - 1 - e.row) * MAP_SCALE + 1, 1, 1).data;
  need(RGB[idx('p')].every((v, i) => dot[i] === v), 'the pause map shows the explorer first');
}

/** The touch leg's difficulty steps, from the slot list with no run open. */
function difficultyLeg(g, { need, click, press, offEntry }) {
  const sized = (d) => g.difficulty === d && g.world.difficulty === d && load(KEY_DIFFICULTY) === d
    && g.world.size.w === DIFFICULTY[d].w && g.world.size.h === DIFFICULTY[d].h;

  // NEW RUN's key cycles the four levels, and the preview's tomb size follows.
  openTitle(g);
  setDifficulty(g, 'easy');
  click('title', 'new');
  need(sized('easy'), 'the setting starts at EASY');
  for (const d of ['medium', 'hard', 'ultimate', 'easy']) {
    click('newrun', 'difficulty');
    need(sized(d), `the difficulty key moves to ${difficultyLabel(d)}`);
  }
  // The arrows step it and stop at the ends.
  for (const [code, d] of [['ArrowRight', 'medium'], ['ArrowRight', 'hard'], ['ArrowRight', 'ultimate'], ['ArrowRight', 'ultimate'],
    ['ArrowLeft', 'hard'], ['ArrowLeft', 'medium'], ['ArrowLeft', 'easy'], ['ArrowLeft', 'easy']]) {
    press(code, code);
    need(sized(d), `${code} steps the setting to ${difficultyLabel(d)}`);
  }
  click('newrun', 'back');

  // A save resumes at the difficulty that wrote it, with no run open, as at startup. Each one takes
  // slot 1 from its EMPTY row.
  const saveAt = (d) => {
    clearSaves();
    openTitle(g);
    click('title', 's1');
    setDifficulty(g, d);
    softTap(g, click, 'newrun', 'begin');
    offEntry();
    earnFake(g);
    click('play', 'pause');
    need(saveNow(1).level === d, `PAUSE stores ${difficultyLabel(d)} with the save`);
    const where = { x: g.sim.bd.x, y: g.sim.bd.y, sim: g.sim };
    click('pause', 'title');
    g.open = null;
    return where;
  };
  // P with no run open asks CONTINUE SLOT 1? over the lit row, and the YES key restores the save.
  const yes = () => softTap(g, click, 'confirm', 'yes');
  const resumesAt = (d, where) => {
    press('KeyP', 'p');
    need(g.screen === 'title' && g.confirm !== null, `RESUME with no open run asks CONTINUE? at ${difficultyLabel(d)}`);
    yes();
    need(g.screen === 'play' && sized(d), `RESUME rebuilds the save at ${difficultyLabel(d)} and moves the setting`);
    need(g.sim !== where.sim && g.sim.bd.x === where.x && g.sim.bd.y === where.y, `the ${difficultyLabel(d)} save resumes on its board`);
  };
  // NEW RUN steps the setting, and Q keeps it on the way back to the slot list.
  const stepSetting = (code, times) => {
    press('KeyN', 'n');
    for (let i = 0; i < times; i++) press(code, code);
    press('KeyQ', 'q');
  };
  // A HARD save resumes at HARD, the 4x4 world.
  const hard = saveAt('hard');
  stepSetting('ArrowLeft', 2);
  need(sized('easy'), 'the setting moves to EASY over a HARD save');
  resumesAt('hard', hard);
  need(g.world.size.w === 4 && g.world.size.h === 4, 'a HARD save resumes in a 4x4 world');
  click('play', 'pause');
  click('pause', 'title');
  g.open = null;
  const old = saveAt('ultimate');
  stepSetting('ArrowLeft', 3);
  need(sized('easy'), 'the setting moves to EASY over an ULTIMATE save');
  // A held P or Esc repeats; the title ignores the repeat, as it does Space's.
  press('KeyP', 'p', true);
  need(g.screen === 'title' && g.confirm === null, 'the title ignores an auto-repeated P');
  press('Escape', 'Escape', true);
  need(g.screen === 'title' && g.confirm === null, 'the title ignores an auto-repeated Esc');
  press('KeyP', 'p');
  yes();
  need(g.screen === 'play' && sized('ultimate') && g.sim.bd.x === old.x && g.sim.bd.y === old.y, 'RESUME plays the ULTIMATE save on its board');
  click('play', 'pause');
  click('pause', 'title');
  g.open = null;
  const easy = saveAt('easy');
  stepSetting('ArrowRight', 1);
  need(sized('medium'), 'the setting moves to MEDIUM over an EASY save');
  resumesAt('easy', easy);

  // NEW SEED rolls a new seed and keeps the slot.
  click('play', 'pause');
  click('pause', 'title');
  const kept = load(saveKey(1)), code = g.code;
  click('title', 'new');
  click('newrun', 'seed');
  click('newrun', 'back');
  need(g.code !== code && kept !== null && load(saveKey(1)) === kept, 'NEW SEED changes the seed and keeps the slot');

  // The best tomb is per seed and difficulty; ULTIMATE keeps the bare seed code.
  click('title', 'resume');
  store(KEY_BEST, '{}');
  g.sim.net = 7;
  g.sim.high = 7;
  endRun(g);
  draw(g, 0);
  const bests = JSON.parse(load(KEY_BEST));
  need(bests[`${g.code}:EASY`] === 7 && bests[g.code] === undefined, 'an EASY run records its best under the seed and EASY');
  click('over', 'title');
  store(KEY_BEST, JSON.stringify({ [g.code]: 5, [`${g.code}:EASY`]: 2, [`${g.code}:MEDIUM`]: 3, [`${g.code}:HARD`]: 4 }));
  for (const [d, best] of [['easy', 2], ['medium', 3], ['hard', 4], ['ultimate', 5]]) {
    setDifficulty(g, d);
    need(titleBest(g) === best, `BEST TOMB reads ${best} at ${difficultyLabel(d)}`);
  }
  draw(g, 0);
}

/**
 * Runs the game's own tick, steered by `drive`, until `done()`. Throws
 * `touch <what>` when `budget` ticks pass first. `seen` runs after each tick.
 */
function runTicks(g, drive, done, budget, what, seen = () => {}) {
  let ph = 0, pv = 0;
  for (let i = 0; i < budget; i++) {
    if (done()) return;
    const [h, v, jump] = drive(g.sim);
    g.keys.clear();
    if (h < 0) g.keys.add('l');
    if (h > 0) g.keys.add('r');
    if (v > 0) g.keys.add('u');
    if (v < 0) g.keys.add('d');
    const edges = inputEdges(ph, pv, h, v);
    g.press = edges.press;
    g.release = edges.release;
    g.jump = jump;
    tick(g);
    seen();
    ph = h;
    pv = v;
  }
  if (!done()) throw new Error(`touch ${what}`);
}

/** Tomb (0, 0)'s exit board, where the self-test starts its runs. */
function exitBoard(world) {
  const at = boardCoords(0, 0, world.tomb(0, 0).X, world.size);
  return world.board(at.x, at.y);
}

/**
 * Scores one tomb along the forward chain: starts a run on the game's world at
 * the first primary cell of tomb (0, 0)'s exit board, at net and high `n`, and
 * walks it out (`walkOut`). It returns the ticks run and the floor coins the
 * walk took.
 */
function oneTombOn(g, n, doomAt = 0) {
  const X = exitBoard(g.world);
  begin(g, X.p, { time: 0, entry: { p: X.p, net: n }, high: n, lastEntry: X.p, trail: createTrail(), start: { u: 0, v: 0 } });
  return walkOut(g, n, doomAt);
}

/**
 * Walks the run at tomb (0, 0)'s exit board to its chain's last member, Q,
 * the cell across the exit door, until the tomb count reaches n + 1. Throws
 * `touch ...` when the walk runs out of ticks. It returns the ticks run and
 * the floor coins the walk took, which a wallet check nets out. With `doomAt`
 * > 0, the torch is an ember that goes out on that tick. The walk has
 * `budget` ticks.
 */
function walkOut(g, n, doomAt = 0, budget = 4000) {
  const chain = g.world.tombFlames(0, 0).chains[0];
  const auto = createAutopilot(g.world, [chain[chain.length - 1]]);
  let coins = 0, ticks = 0;
  const drive = (s) => {
    if (++ticks === doomAt) { s.burn = 0; s.ember = TICK / 2; }
    return auto(s);
  };
  runTicks(g, drive, () => tombCount(g.sim) >= n + 1, budget,
    `the walk out of tomb (0, 0) reaches tomb count ${n + 1}`, () => { for (const ev of g.sim.events) if (ev === 'coin') coins++; });
  return { ticks, coins };
}

/** A record of the self-test's MEDIUM seed with nothing earned; `putSave` fills in what a step changes. */
const SAVE_BASE = { id: 'AAAAAAAA', save: 'K7Q2-M9XA:13', level: 'medium', start: '0,0', net: 0, high: 0, wallet: 0, continues: 0, recent: [] };

/** Stores slot n's record, made of SAVE_BASE and `over`, as text. */
function putSave(n, over = {}) {
  store(saveKey(n), serializeSave({ ...SAVE_BASE, ...over }));
}

/** Slot n's stored record, or null when it holds none. */
function saveNow(n = 1) {
  const held = heldSave(n);
  return held.state === 'valid' ? held.record : null;
}

/** Empties the three slots. */
function clearSaves() {
  for (const n of SAVE_SLOTS) unstore(saveKey(n));
}

/** The three slots' stored text, joined: a step that must write nothing leaves it as it was. */
const savesText = () => SAVE_SLOTS.map((n) => load(saveKey(n))).join('\u0001');

/** True when the game's economy is clean: no slot, no save and wallet 0. */
const isClean = (g) => g.slot === null && g.saveId === null && g.wallet === 0;

/** A clean run bound to slot n, emptied first: its first coin or counted tomb takes the slot. */
function bindSlot(g, n) {
  unstore(saveKey(n));
  cleanState(g, n);
}

/** Sends game `h` a keydown, as the window would a key; `h` is a game made by `reload`, with no listener of its own. */
function keyTo(h, code, key, repeat = false) {
  onKeyDown(h, new KeyboardEvent('keydown', { code, key, repeat, bubbles: true, cancelable: true }));
}

/** Game `h` plays slot n's row from the slot list and answers Y at CONTINUE SLOT n?. */
function continueSlot(h, n) {
  keyTo(h, `Digit${n}`, String(n));
  keyTo(h, 'KeyY', 'y');
}

/** Draws a frame, so the touch layer places its keys, then clicks soft key `id` of screen `sid`. */
function softTap(g, click, sid, id) {
  draw(g, 0);
  click(sid, id);
}

/** The slot list with no run open, as at startup. The economy stays as it is. */
function openTitle(g) {
  g.open = null;
  g.saveIn = null;
  toTitle(g);
  draw(g, 0);
}

/** Runs `fn` with `window.prompt` answering `answer`. */
function withPrompt(answer, fn) {
  const real = window.prompt;
  try {
    window.prompt = () => answer;
    fn();
  } finally {
    window.prompt = real;
  }
}

/** A fresh game over the same storage, as after a page reload: the migration runs first. */
function reload() {
  const h = newGame();
  useCode(h, h.code);
  return h;
}

/** The run takes a coin the board lacks, through the game's own tick write. */
function earnFake(g) {
  tickSave(g, 1, tombCount(g.sim), false, false);
}

/**
 * The coin a run from the start point meets first, as { bd, cell, i }: coin 0
 * of the row east of the start cell, 17 px along the corridor, which the walk
 * east touches before any other coin. Null when that cell holds no row.
 */
function firstCoin(world) {
  const { board, cell } = world.startPoint();
  return coinRows(world, board).includes(cell) ? { bd: board, cell, i: 0 } : null;
}

/** The floor point of `item`, a dead-end coin or jar on `cell` or coin `i` of the row east of it. */
const itemPoint = ({ bd, cell, i }) => (i === undefined ? itemSpot(bd, cell) : rowSpot(bd, cell, i));

/**
 * Walks the run to the cell of `item` (its dead-end cell, or a row's west
 * cell), then toward its spot until the feet come within 12 px of it, as the
 * sim tests contact. `seen` runs after each tick. Throws `touch ...` when the
 * walk runs out of ticks.
 */
function walkToItem(g, item, seen = () => {}, what = 'coin') {
  const { bd, cell } = item;
  const [sx, sy] = itemPoint(item);
  const side = Math.sign(sx - nodeXY(bd, cell)[0]);
  const auto = createAutopilot(g.world, [{ x: bd.x, y: bd.y, cell }]);
  const here = (s) => s.bd.x === bd.x && s.bd.y === bd.y && s.cell === cell && s.mode === 'floor';
  const near = () => { const [fx, fy] = feet(g.sim); return Math.abs(fx - sx) <= 12 && Math.abs(fy - sy) <= 12; };
  runTicks(g, (s) => (here(s) ? [side, 0, false] : auto(s)), near, 20000, `the walk reaches the ${what}`, seen);
}

/** The oil jars of tomb (0, 0), board by board in index order, as { bd, cell }. */
function tombJars(world) {
  const out = [];
  for (let i = 0; i < world.size.w * world.size.h; i++) {
    const { x, y } = boardCoords(0, 0, i, world.size);
    const bd = world.board(x, y);
    for (const it of floorItems(world, bd)) if (it.kind === 'oil') out.push({ bd, cell: it.cell });
  }
  return out;
}

/**
 * The cell across the exit door of tomb (u, v), where the chain that starts at
 * cell `from` ends; the first chain when `from` is null.
 */
function exitCell(world, u, v, from = null) {
  const { chains } = world.tombFlames(u, v);
  const chain = from ? chains.find((c) => c[0].x === from.x && c[0].y === from.y && c[0].cell === from.cell) : chains[0];
  return chain[chain.length - 1];
}

/**
 * Walks game `h`, torch full, to the floor of cell `goal` { x, y, cell }, and
 * returns the coins the walk took. Throws `touch ...` when the walk runs out
 * of ticks.
 */
function walkToCell(h, goal, what) {
  h.sim.burn = BURN_S;
  const auto = createAutopilot(h.world, [goal]);
  const at = () => { const s = h.sim; return s.bd.x === goal.x && s.bd.y === goal.y && s.cell === goal.cell && s.mode === 'floor'; };
  let coins = 0;
  runTicks(h, auto, at, 30000, what, () => { for (const ev of h.sim.events) if (ev === 'coin') coins++; });
  return coins;
}

/** The oil steps of the touch leg, from the slot list with no run open. Each run is bound to slot 1. */
function oilLeg(g, { need, click }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const jars = tombJars(g.world);
  need(jars.length >= 2, 'tomb (0, 0) holds two oil jars at MEDIUM');
  // Each step walks a new run to one jar with the burn pinned to `burn` before
  // every tick until the jar is taken. The contact tick then burns one TICK
  // and adds the jar.
  const take = (jar, burn) => {
    clearSaves();
    openTitle(g);
    click('title', 's1');
    softTap(g, click, 'newrun', 'begin');
    const id = coinId(jar.bd, jar.cell);
    let delta = null;
    g.sim.burn = burn;
    walkToItem(g, jar, () => {
      const s = g.sim;
      if (s.jars.has(id)) { if (delta === null) delta = s.burn - burn; } else s.burn = burn;
    }, 'oil jar');
    return { delta, after: g.sim.burn };
  };
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  // Step 1: burn 100 s takes the jar's 60 s.
  const one = take(jars[0], 100);
  need(one.delta !== null && near(one.delta, 60 - TICK), 'touching the first oil jar at 100 s adds 60 s');

  // Step 2: burn 280 s caps at full.
  const two = take(jars[1], 280);
  need(two.delta !== null && near(two.after, BURN_S - TICK), 'touching the second oil jar at 280 s caps the burn at full');
  draw(g, 0);
}

/**
 * The gamepad steps of the touch leg, from the slot list with no run open.
 * Each button change polls the fake gamepad, as the frame loop does.
 */
function gamepadLeg(g, { need, click, fake }) {
  const hold = (...buttons) => {
    fake.held = new Set(buttons);
    pollGamepads();
  };
  const tap = (button) => {
    hold(button);
    hold();
  };
  const A = 0, B = 1, SELECT = 8, START = 9, DOWN = 13, LEFT = 14, RIGHT = 15;
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  openTitle(g);
  click('title', 'new');
  click('newrun', 'begin');
  const run = g.sim;

  g.press = 0;
  hold(LEFT);
  need(g.keys.has('l') && (g.press & KEY.L) !== 0, 'gamepad d-pad left holds Left');
  hold();
  need(!g.keys.has('l'), 'gamepad d-pad left holds Left');
  g.press = 0;
  g.release = 0;

  g.jump = false;
  hold(A);
  need(g.jump, 'gamepad A jumps');
  hold();
  g.jump = false;

  hold(START);
  const paused = g.screen === 'pause';
  hold();
  hold(START);
  need(paused && g.screen === 'play' && g.sim === run, 'gamepad Start pauses and resumes');
  hold();

  hold(START);
  hold();
  hold(SELECT);
  need(g.screen === 'title' && g.open !== null && g.open.sim === run, 'gamepad Select reaches the title from pause');
  hold();

  draw(g, 0);
  click('title', 'resume');
  showSplash(g, 1, false);
  hold(A);
  const kept = g.screen === 'splash';
  hold();
  hold(B);
  need(kept && g.screen === 'play', 'gamepad A leaves the splash showing and B continues');
  hold();
  g.press = 0;
  g.release = 0;
  g.jump = false;

  // CONTINUE? by gamepad: Start asks; A and Start change nothing; Select answers no and B yes.
  const board = g.world.startPoint().board;
  clearSaves();
  putSave(1, { save: encodeSave(SELFTEST_CODE, board.x, board.y), net: 20, high: 20, wallet: 300 });
  cleanState(g);
  openTitle(g);
  tap(START);
  need(g.screen === 'title' && g.confirm !== null, 'RESUME with no open run asks CONTINUE? by a gamepad\'s Start');
  tap(A);
  tap(START);
  need(g.screen === 'title' && g.confirm !== null && isClean(g), 'a gamepad answers CONTINUE? A and Start change nothing');
  tap(SELECT);
  need(g.screen === 'title' && g.confirm === null && isClean(g), 'a gamepad answers CONTINUE? Select answers no');
  tap(START);
  tap(B);
  need(g.screen === 'play' && g.wallet === 300 && tombCount(g.sim) === 20, 'a gamepad answers CONTINUE? B answers yes');
  g.press = 0;
  g.release = 0;
  g.jump = false;

  // A controller reaches every choice over three used slots, the pad alone: Down to the N NEW RUN row and B
  // open NEW RUN unbound; Select returns; Down, Right and B enter erasing; B on a used row asks ERASE SLOT n?,
  // where A and Start answer nothing, Select no and B yes, removing that key alone.
  clearSaves();
  for (const n of SAVE_SLOTS) putSave(n, { id: `${'ABC'[n - 1]}AAAAAAA`, wallet: n });
  cleanState(g);
  openTitle(g);
  for (let i = 0; i < 3; i++) tap(DOWN);
  tap(B);
  need(g.screen === 'newrun' && g.bind === null, 'a controller\'s Down and B open NEW RUN unbound from the N NEW RUN row');
  tap(SELECT);
  need(g.screen === 'title' && g.cursor === NEW_ROW, 'a controller\'s Select returns from NEW RUN to the slot list');
  const enterErasing = () => {
    for (let i = 0; i < 3; i++) tap(DOWN);
    tap(RIGHT);
    tap(B);
    need(g.screen === 'title' && g.erasing && g.cursor === 0, 'a controller\'s Down, Right and B enter erasing');
    tap(B);
    need(g.confirm !== null && g.confirm.kind === 'erase' && g.confirm.n === 1, 'a controller\'s B on a used row asks ERASE SLOT 1?');
  };
  const before = savesText();
  enterErasing();
  tap(A);
  tap(START);
  need(g.confirm !== null && savesText() === before, 'a controller\'s A and Start answer nothing at ERASE SLOT 1?');
  tap(SELECT);
  need(g.confirm === null && !g.erasing && savesText() === before, 'a controller\'s Select answers no at ERASE SLOT 1?');
  enterErasing();
  tap(B);
  need(heldSave(1).state === 'absent' && saveNow(2) !== null && saveNow(3) !== null, 'a controller\'s B at ERASE SLOT 1? removes that key alone');
  cleanState(g);
  clearSaves();
}

/** Walks game `h` toward `home` until its feet lie more than 12 px from `spot`, so a walk to the spot runs ticks. */
function walkAway(h, home, spot) {
  const auto = createAutopilot(h.world, [home]);
  const far = () => { const [fx, fy] = feet(h.sim); return Math.abs(fx - spot[0]) > 12 || Math.abs(fy - spot[1]) > 12; };
  runTicks(h, auto, far, 600, 'the walk leaves the coin');
}

/** The coin steps of the touch leg, from the slot list with no run open. */
function coinLeg(g, { need, click, press }) {
  const rates = { easy: 1, medium: 2, hard: 5, ultimate: 10 };
  const onLevel = (d) => {
    setDifficulty(g, d);
    useCode(g, SELFTEST_CODE);
  };

  // Step 1: the first coin of tomb (0, 0) at MEDIUM takes the slot its EMPTY row bound.
  cleanState(g);
  clearSaves();
  onLevel('medium');
  openTitle(g);
  click('title', 's1');
  need(g.screen === 'newrun' && g.bind === 1, 'an EMPTY row opens NEW RUN bound to its slot');
  click('newrun', 'begin');
  need(g.screen === 'play' && g.earned === 0, 'BEGIN starts a run with no coins earned');
  const coin = firstCoin(g.world);
  need(coin !== null, 'tomb (0, 0) holds a coin at MEDIUM');
  walkToItem(g, coin);
  need(g.sim.events.includes('coin') && g.wallet === 1, 'touching the first coin adds one to the wallet');
  need(g.earned === 1, 'a coin counts as one earned this run');
  const slot = saveNow(1);
  need(slot !== null && slot.wallet === 1, 'a touched coin stores the wallet');
  need(slot.level === 'medium' && !('coins' in JSON.parse(load(saveKey(1)))), 'a touched coin stores the wallet and no coin in the slot');
  need(realUntouched(), 'the self-test leaves the real wallet untouched');

  // Step 2: the coin stays taken through pause, the title, the end screen's CONTINUE and a reload, and lies
  // back on BEGIN. Each walk to it starts with the feet out of reach, so the walk runs ticks, and the coins
  // it takes are the pickups the sim reports, which no merge of the wallet changes.
  const origin = g.world.startPoint(), home = { x: origin.board.x, y: origin.board.y, cell: origin.cell };
  const spot = itemPoint(coin);
  const takes = (h) => {
    let n = 0;
    walkAway(h, home, spot);
    walkToItem(h, coin, () => { for (const ev of h.sim.events) if (ev === 'coin') n++; });
    return n;
  };
  const run = g.sim;
  press('KeyP', 'p');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim === run && takes(g) === 0, 'a coin taken stays gone through P and P');
  press('KeyP', 'p');
  press('KeyQ', 'q');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim === run && takes(g) === 0, 'a coin taken stays gone through Q, the title and RESUME');
  endRun(g);
  draw(g, 0);
  click('over', 'continue');
  need(g.screen === 'play' && g.sim !== run && takes(g) === 0, 'the end screen CONTINUE keeps the coin taken');
  const later = reload();
  continueSlot(later, 1);
  need(later.screen === 'play' && takes(later) === 0, 'RESUME after a reload keeps the coin taken');
  openTitle(g);
  click('title', 'new');
  click('newrun', 'begin');
  need(g.screen === 'play' && takes(g) === 1, 'BEGIN lays the coin back');

  // Step 3: each level from an EMPTY slot. A rise of the high pays the level's rate, and a replay of the
  // tomb pays nothing, since the save's high already holds it. Each wallet check nets out the floor coins
  // the walk took, which lie back with every new run.
  for (const d of DIFFICULTIES) {
    const label = difficultyLabel(d);
    bindSlot(g, 1);
    onLevel(d);
    const first = oneTombOn(g, 0);
    need(g.wallet - first.coins === rates[d], `a rise of the high pays ${rates[d]} at ${label}`);
    const stored = saveNow(1);
    need(stored.wallet === g.wallet && stored.high === 1 && stored.level === d, `the payout stores the wallet and the high at ${label}`);
    const replay = oneTombOn(g, 0);
    need(g.wallet - first.coins - replay.coins === rates[d], `a replay of a counted tomb pays nothing at ${label}`);
  }

  // Step 4: the coins earned this run equal the wallet's gain since BEGIN.
  clearSaves();
  onLevel('medium');
  openTitle(g);
  click('title', 's1');
  click('newrun', 'begin');
  const start = g.wallet;
  walkToItem(g, firstCoin(g.world));
  oneTombOn(g, 0);
  need(g.earned > 0 && g.earned === g.wallet - start, 'the coins earned this run equal the wallet\'s gain');
  endRun(g);
  draw(g, 0);
  need(g.earned === g.wallet - start, 'the end screen keeps the coins earned');
  click('over', 'continue');
  need(g.screen === 'play' && g.earned === g.wallet - start, 'CONTINUE keeps the coins earned this run');
  oneTombOn(g, 1);
  need(g.earned === g.wallet - start, 'the coins earned this run still equal the wallet\'s gain after CONTINUE');
  draw(g, 0);

  // Step 5: the coins and jars of the last two tombs, from slot 1 empty at MEDIUM. A is tomb (0, 0), B the
  // tomb its exit leads to and C the tomb B's exit leads to. A pinned walk holds the burn at 100 s before
  // every tick, so its contact tick shows whether the jar added its 60 s; a long walk starts with the torch
  // full.
  clearSaves();
  onLevel('medium');
  openTitle(g);
  click('title', 's1');
  click('newrun', 'begin');
  const first = firstCoin(g.world), firstId = coinId(first.bd, first.cell, first.i);
  const [jar, jar2] = tombJars(g.world);
  const qa = exitCell(g.world, 0, 0), intoB = g.world.board(qa.x, qa.y);
  const qb = exitCell(g.world, intoB.u, intoB.v, qa);
  const pinned = (h, item, seen = () => {}) => {
    let after = null;
    h.sim.burn = 100;
    walkToItem(h, item, () => { after = h.sim.burn; h.sim.burn = 100; seen(); }, 'oil jar');
    return after === null ? Infinity : after - 100;
  };
  const resumed = () => {
    const h = reload();
    continueSlot(h, 1);
    return h;
  };
  // The coin takes the slot, then the jar; the walk out stores the serial at B.
  g.sim.burn = BURN_S;
  walkToItem(g, first);
  walkToItem(g, jar, undefined, 'oil jar');
  walkOut(g, 0, 0, 20000);
  // The walk back into A fires no entry event, so the tomb change alone writes the slot.
  const back = resumed();
  let turned = false;
  const added = pinned(back, jar, () => {
    if (turned || back.sim.recent[0] !== '0,0') return;
    turned = true;
    need(saveNow(1).recent.map(([tomb]) => tomb).join() === back.sim.recent.join(), 'a walk back into the previous tomb writes the slot\'s recent tombs');
  });
  need(turned && added < 0, 'a reload keeps the previous tomb\'s jar taken');
  // A jar taken since the last tomb entry reaches the slot on its tick.
  back.sim.burn = BURN_S;
  walkToItem(back, jar2, undefined, 'oil jar');
  const again = resumed();
  need(pinned(again, jar2) < 0, 'a reload keeps a jar taken since the last tomb entry');
  // Into B and on into C lays A's takes back, and the walk back to the coin takes it once and pays one.
  walkToCell(again, qa, 'the walk into the next tomb');
  walkToCell(again, qb, 'the walk on into the tomb after');
  again.sim.burn = BURN_S;
  let paid = null, wallet = again.wallet;
  walkToItem(again, first, () => {
    const s = again.sim;
    if (paid === null && s.collected.has(firstId)) paid = { coins: s.events.filter((ev) => ev === 'coin').length, wallet: again.wallet - wallet };
    wallet = again.wallet;
  });
  need(paid !== null && paid.coins === 1 && paid.wallet === 1, 'a coin two tombs back lies back');
}

/** The two-games step of the touch leg, from the slot list with no run open. */
function twoGamesLeg(g, { need }) {
  // Two games that restored one save share its id. A second game, made before the first one's write,
  // earns after it; the merge keeps both.
  cleanState(g);
  clearSaves();
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const first = g.world.startPoint().board;
  putSave(1, { save: encodeSave(SELFTEST_CODE, first.x, first.y) });
  restore(g, 1, saveNow(1));
  const other = reload();
  restore(other, 1, saveNow(1));
  walkToItem(g, firstCoin(g.world));
  earnFake(other);
  const stored = saveNow(1);
  need(stored.wallet === 2 && other.wallet === 2 && other.earned === 1, 'two games on one slot keep both coins');
}

/**
 * The splash steps of the touch leg. `oneTombOn(g, 99)` crosses tomb 100
 * through the shipped tick, so each step reads the screen the game chose.
 * Each run is bound to slot 1.
 */
function splashLeg(g, { need, click, press }) {

  // Step 1: the first crossing of tomb 100 shows TORCHBEARER and pays the rate plus 100, at every level.
  for (const d of DIFFICULTIES) {
    bindSlot(g, 1);
    setDifficulty(g, d);
    useCode(g, SELFTEST_CODE);
    const label = difficultyLabel(d);
    const was = g.wallet, earned = g.earned;
    const { coins } = oneTombOn(g, 99);
    need(g.screen === 'splash' && g.splash.k === 1 && rankName(g.splash.k) === 'TORCHBEARER' && g.splash.paid,
      `tomb 100 shows the splash with TORCHBEARER at ${label}`);
    need(g.wallet - was - coins === COIN_RATE[d] + 100, `tomb 100 pays ${COIN_RATE[d]} plus 100 at ${label}`);
    need(g.earned - earned === g.wallet - was, `the milestone payout counts in the coins earned at ${label}`);
    need(saveNow(1).wallet === g.wallet && saveNow(1).high === 100, `the ${label} milestone payout stores the wallet and the high`);
    // The tick's entry event stores a save too, so the splash's own write shows only over a stale one.
    store(saveKey(1), serializeSave({ ...saveNow(1), save: SAVE_BASE.save }));
    showSplash(g, g.splash.k, g.splash.paid);
    need(saveNow(1).save === hereCode(g), `the ${label} splash stores the save`);
  }
  draw(g, 0);

  // Step 2: P, Esc, Space and a repeated Enter leave the splash showing, and the run stands still.
  const run = g.sim;
  for (const [code, key, repeat, name] of [['KeyP', 'p', false, 'P'], ['Escape', 'Escape', false, 'Esc'],
    ['Space', ' ', false, 'Space'], ['Enter', 'Enter', true, 'a repeated Enter']]) {
    press(code, key, repeat);
    need(g.screen === 'splash', `${name} leaves the splash showing`);
  }
  const time = run.time;
  for (let i = 0; i < 30; i++) tick(g);
  need(g.screen === 'splash' && run.time === time, 'the run stands still under the splash');

  // Step 3: Enter returns to the same run.
  press('Enter', 'Enter');
  need(g.screen === 'play' && g.sim === run, 'Enter returns to play on the same run');

  // Step 4: the second crossing shows the splash and pays nothing, since the save's high holds 100.
  const wallet = g.wallet;
  const again = oneTombOn(g, 99);
  need(g.screen === 'splash' && g.splash.k === 1 && !g.splash.paid, 'a second crossing of tomb 100 shows the splash');
  need(g.wallet - wallet === again.coins, 'a second crossing of tomb 100 pays nothing');
  draw(g, 0);

  // Step 5: Q leaves the run open, and P on the title returns to it in play with its torch and time.
  const second = g.sim;
  second.burn = BURN_S / 2;
  second.time = 77;
  press('KeyQ', 'q');
  need(g.screen === 'title' && g.open !== null && g.open.sim === second, 'Q reaches the title with the run open');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim === second, 'P on the title returns to the run in play');
  need(second.burn === BURN_S / 2 && second.time === 77, 'the resumed run keeps its torch and time');

  // Step 6: the soft keys do what Enter and Q do.
  oneTombOn(g, 99);
  draw(g, 0);
  need(g.screen === 'splash', 'a third crossing of tomb 100 shows the splash');
  const third = g.sim;
  click('splash', 'continue');
  need(g.screen === 'play' && g.sim === third, 'the splash CONTINUE reaches play on the same run');
  oneTombOn(g, 99);
  draw(g, 0);
  const fourth = g.sim;
  click('splash', 'home');
  need(g.screen === 'title' && g.open !== null && g.open.sim === fourth, 'the splash HOME reaches the title with the run open');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim === fourth, 'P after the splash HOME returns to the run');

  // Step 7: a run that ends on the tick that crosses tomb 100 shows the end screen, and the payout stands. A
  // fresh save on slot 1 holds no high, so the crossing pays again.
  const { ticks } = oneTombOn(g, 99);
  const level = g.world.difficulty;
  bindSlot(g, 1);
  const before = g.wallet;
  const ended = oneTombOn(g, 99, ticks);
  need(g.screen === 'over' && tombCount(g.sim) === 100, 'a run that ends on the crossing of tomb 100 shows the end screen');
  need(g.wallet - before - ended.coins === COIN_RATE[level] + 100, 'the payout stands when the run ends on the crossing of tomb 100');
  draw(g, 0);
}

/**
 * The RESUME steps of the touch leg, from the slot list with no run open. Each
 * `reload` is a fresh game over the same storage, as after a page reload.
 */
function resumeLeg(g, { need, click }) {
  const level = 'medium';
  setDifficulty(g, level);
  useCode(g, SELFTEST_CODE);
  clearSaves();
  openTitle(g);
  click('title', 's1');
  click('newrun', 'begin');
  oneTombOn(g, 1);
  const count = tombCount(g.sim);
  draw(g, 0);
  click('play', 'pause');
  const saved = saveNow(1).save;

  // The count survives a reload through the slot.
  const resumed = reload();
  continueSlot(resumed, 1);
  need(count >= 2 && resumed.screen === 'play' && tombCount(resumed.sim) === count, `RESUME after a reload continues at TOMB ${count}`);
  need(resumed.sim.start.u === 0 && resumed.sim.start.v === 0 && resumed.earned === 0, 'a resumed run keeps its start tomb and earns afresh');

  // A typed copy of the slot's serial continues it; another code does not, as it carries no count.
  const typed = (text) => {
    const h = reload();
    h.typing = text;
    submitTyped(h);
    if (h.confirm) keyTo(h, 'KeyY', 'y');
    return tombCount(h.sim);
  };
  const elsewhere = encodeSave(SELFTEST_CODE, g.sim.bd.x + 1, g.sim.bd.y);
  need(typed(saved) === count, `a typed copy of the slot's serial continues at TOMB ${count}`);
  need(typed(elsewhere) === 0, 'another save code starts at TOMB 0');

  // A save at net 99 under a high of 100 crosses back up to its high: TOMB 100 holds, nothing pays and no
  // splash shows.
  const exit = exitBoard(g.world), at = encodeSave(SELFTEST_CODE, exit.x, exit.y);
  putSave(1, { save: at, net: 99, high: 100 });
  const late = reload();
  continueSlot(late, 1);
  need(tombCount(late.sim) === 100 && late.sim.net === 99, 'RESUME after a reload continues at TOMB 100 from net 99');
  const was = late.wallet;
  const chain = late.world.tombFlames(0, 0).chains[0], auto = createAutopilot(late.world, [chain[chain.length - 1]]);
  let coins = 0;
  runTicks(late, auto, () => late.sim.net >= 100, 4000, 'the walk out of tomb (0, 0) reaches net 100',
    () => { for (const ev of late.sim.events) if (ev === 'coin') coins++; });
  need(late.screen === 'play' && tombCount(late.sim) === 100 && late.wallet - was === coins && saveNow(1).high === 100,
    'a resumed run crossing back up to its high pays nothing and shows no splash');
}

/**
 * CONTINUE SLOT n? and the continue count, from the slot list with no run
 * open: the touch keys, P and a typed serial ask over slot 1's row, Y restores
 * the record drawn, and only a death raises the count.
 */
function continueLeg(g, { need, click, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const coin = firstCoin(g.world), first = g.world.startPoint().board;
  const serial = encodeSave(SELFTEST_CODE, first.x, first.y);
  // Slot 1 holds 300 coins and TOMB 20 at tomb (0, 0)'s first board; slots 2 and 3 are empty.
  const toTitle = () => {
    clearSaves();
    putSave(1, { save: serial, net: 20, high: 20, wallet: 300 });
    cleanState(g);
    openTitle(g);
  };
  const typeIn = (text) => {
    press('KeyN', 'n');
    withPrompt(text, () => softTap(g, click, 'newrun', 'type'));
  };
  const tap = (sid, which) => softTap(g, click, sid, which);
  // CONTINUE SLOT 1? stands on the slot list over the slot...
  const over = () => g.screen === 'title' && g.confirm !== null && g.confirm.kind === 'continue' && g.confirm.n === 1
    && g.confirm.held.record.wallet === 300 && g.confirm.held.record.high === 20;
  // ...and has restored nothing.
  const asks = () => over() && isClean(g);
  // The slot list after a played, restored run: wallet 300 under save AAAAAAAA, not clean.
  const played = () => {
    toTitle();
    tap('title', 's1');
    press('KeyY', 'y');
    endRun(g);
    tap('over', 'title');
    need(g.screen === 'title' && g.saveId === SAVE_BASE.id && g.wallet === 300, 'a played run leaves the title with its wallet');
  };
  const restored = () => g.screen === 'play' && g.slot === 1 && g.saveId === SAVE_BASE.id && g.wallet === 300 && tombCount(g.sim) === 20
    && g.sim.collected.size === 0;

  // A typed serial on another seed starts clean.
  toTitle();
  typeIn('K7Q2-M9XA:13');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'a new serial starts with no coins');

  // SLOT 1 asks CONTINUE SLOT 1?; N, from the slot row and from TYPE CODE, returns to the slot list and keeps the slot.
  toTitle();
  tap('title', 's1');
  need(asks(), 'RESUME with no open run asks CONTINUE? by the touch SLOT 1 key');
  press('KeyN', 'n');
  need(g.screen === 'title' && g.confirm === null && g.open === null && isClean(g) && saveNow(1).wallet === 300,
    'N returns to the slot list and erases nothing');
  press('KeyP', 'p');
  need(asks(), 'RESUME with no open run asks CONTINUE? by P');
  press('KeyN', 'n');
  typeIn(serial);
  press('Escape', 'Escape');
  need(g.screen === 'title' && g.confirm === null, 'Esc answers no to CONTINUE?');
  typeIn(serial);
  need(asks(), 'TYPE CODE with the slot\'s serial asks CONTINUE?');
  press('KeyN', 'n');
  need(g.screen === 'title' && g.confirm === null && isClean(g) && saveNow(1).wallet === 300, 'N returns to the title with no coins from TYPE CODE');
  press('KeyP', 'p');
  press('KeyQ', 'q');
  need(g.screen === 'title' && g.confirm === null, 'Q answers no to CONTINUE?');

  // CONTINUE? takes no repeated key and no key that answers neither way.
  press('KeyP', 'p');
  press('KeyY', 'y', true);
  press('Enter', 'Enter', true);
  press('KeyN', 'n', true);
  press('Escape', 'Escape', true);
  need(asks(), 'CONTINUE? ignores a repeated key');
  press('Space', ' ');
  press('KeyP', 'p');
  press('KeyL', 'l');
  need(asks(), 'CONTINUE? ignores a key that answers neither way');

  // Y and Enter restore the slot's wallet and TOMB 20, with every coin back on the floor.
  press('KeyY', 'y');
  need(restored(), 'Y restores the slot\'s wallet and TOMB 20');
  walkToItem(g, coin);
  need(g.wallet === 301 && g.earned === 1, 'a coin of the restored tomb lies back and pays one');
  endRun(g);
  draw(g, 0);
  click('over', 'continue');
  need(g.screen === 'play' && g.saveId === SAVE_BASE.id && g.wallet === 301 && saveNow(1).id === SAVE_BASE.id, 'Continue keeps the run\'s slot and coins');
  toTitle();
  typeIn(serial);
  press('Enter', 'Enter');
  need(restored(), 'Enter answers yes to CONTINUE? from TYPE CODE');

  // Y restores the record CONTINUE? showed, not whatever is stored when Y comes.
  toTitle();
  tap('title', 's1');
  need(asks(), 'RESUME with no open run asks CONTINUE? before the slot changes');
  putSave(1, { id: 'BBBBBBBB', save: encodeSave(SELFTEST_CODE, first.x + 1, first.y), wallet: 7 });
  press('KeyY', 'y');
  need(restored() && saveNow(1).id === 'BBBBBBBB', 'Y restores the snapshot CONTINUE? showed');

  // A typed serial and BEGIN start clean after a played run.
  played();
  typeIn('K7Q2-M9XA:13');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'a typed serial other than the slot\'s starts clean');
  played();
  tap('title', 'new');
  tap('newrun', 'begin');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'BEGIN after a restored run starts with no coins at TOMB 0');

  // The soft keys answer CONTINUE?.
  toTitle();
  tap('title', 's1');
  tap('confirm', 'no');
  need(g.screen === 'title' && g.confirm === null && isClean(g), 'the soft keys answer CONTINUE? NO');
  tap('title', 's1');
  tap('confirm', 'yes');
  need(restored(), 'the soft keys answer CONTINUE? YES');

  // The continue count: only a death raises it. Each death ends the torch through the sim, so the tick's own
  // endRun writes; a bare endRun leaves the run live and stores no rise.
  const die = () => {
    g.sim.burn = 0;
    g.sim.ember = TICK / 2;
    runTicks(g, () => [0, 0, false], () => g.screen === 'over', 10, 'the torch dies');
  };
  toTitle();
  tap('title', 's1');
  press('KeyY', 'y');
  need(restored() && g.sim.continues === 0, 'Y restores a slot at 0 continues');
  die();
  draw(g, 0);
  click('over', 'continue');
  need(g.screen === 'play' && g.sim.continues === 1, 'a death and CONTINUE raise the continue count to 1');
  press('KeyP', 'p');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim.continues === 1, 'P and P hold the continue count at 1');
  press('KeyP', 'p');
  press('KeyQ', 'q');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim.continues === 1, 'Q, the title and RESUME hold the continue count at 1');
  die();
  need(g.sim.continues === 1 && saveNow(1).continues === 2, 'a second death stores 2 in the slot while the end screen shows 1');
  draw(g, 0);
  press('KeyQ', 'q');
  need(g.screen === 'title', 'Q leaves the end screen for the title');
  tap('title', 's1');
  press('KeyY', 'y');
  need(restored() && g.sim.continues === 2, 'Q, RESUME and Y restore the stored count of 2');
  draw(g, 0);
  click('play', 'pause');
  const after = reload();
  continueSlot(after, 1);
  need(after.screen === 'play' && after.sim.continues === 2 && saveNow(1).continues === 2, 'a PAUSE, a reload, RESUME and Y hold the count at 2');
  openTitle(g);
  click('title', 'new');
  click('newrun', 'begin');
  need(g.screen === 'play' && g.sim.continues === 0, 'BEGIN starts the continue count at 0');

  // Two live games on one save share the count by maximum: one dies, the other's next write adopts the rise.
  toTitle();
  tap('title', 's1');
  press('KeyY', 'y');
  const twin = reload();
  continueSlot(twin, 1);
  need(restored() && twin.screen === 'play' && twin.sim.continues === 0, 'two games restore one slot at 0 continues');
  die();
  need(saveNow(1).continues === 1 && twin.sim.continues === 0, 'a death stores the raised count before the other game writes');
  commit(twin, twin.point);
  need(twin.sim.continues === 1 && saveNow(1).continues === 1, 'a live game adopts another\'s death on its next write');
}

/**
 * The farming loops, at MEDIUM. A is tomb (0, 0) and B the tomb its exit leads
 * to; each run starts on A's exit board, which is no entry, and crosses its
 * exit door into B, raising the high to 1. Stepping back onto that board, a
 * PAUSE or a SAVE through SAVE IN? pairs it with the net there, so a reload, a
 * restore and the step forward never raise TOMB n, the save's high or the
 * wallet past the coins the walks take.
 */
function farmLeg(g, { need }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const t = g.world.tomb(0, 0), X = exitBoard(g.world);
  const gate = { x: X.x, y: X.y, cell: X.doors.find((dr) => dr.dir === t.exit).cell };
  const across = g.world.step(X, gate.cell, t.exit), into = { x: across.board.x, y: across.board.y, cell: across.cell };
  need(!X.entry, 'tomb (0, 0)\'s exit board is no entry at MEDIUM');
  const H = 1;
  // Before each PAUSE or SAVE IN?, the explorer stands on no entry, its net apart from the entry save point's.
  const offEntry = (h, what) => need(!h.sim.bd.entry && h.sim.here.net !== h.sim.entry.net, `${what}: the explorer stands on no entry, off the entry's net`);
  const holds = (h, wallet, what) => need(h.screen === 'play' && tombCount(h.sim) === H && saveNow(1).high === H
    && h.wallet === wallet && saveNow(1).wallet === wallet, what);
  const start = (slot) => {
    clearSaves();
    openTitle(g);
    cleanState(g, slot);
    begin(g, X.p);
  };

  // Bound: the run takes slot 1 at the crossing into B, then three times steps back, PAUSEs, reloads,
  // restores the slot and steps forward into B again.
  start(1);
  let coins = walkToCell(g, into, 'the walk into tomb B');
  need(g.screen === 'play' && tombCount(g.sim) === H && saveNow(1) !== null && saveNow(1).id === g.saveId, 'the bound crossing into B takes slot 1 at TOMB 1');
  let wallet = g.wallet - coins, h = g;
  for (let loop = 1; loop <= 3; loop++) {
    coins += walkToCell(h, gate, 'the walk back into tomb A');
    offEntry(h, `bound loop ${loop}`);
    keyTo(h, 'KeyP', 'p');
    h = reload();
    continueSlot(h, 1);
    coins += walkToCell(h, into, 'the walk forward into tomb B');
    holds(h, wallet + coins, `bound loop ${loop}: TOMB n, the high and the wallet hold at H`);
  }

  // Unbound: the crossing into B opens SAVE IN?, which Q dismisses. Each loop steps back, pauses, saves to
  // slot 1 through SAVE IN?, reloads, restores the slot and steps forward into B again; another tab then
  // erases the slot, so the run's next write stores nothing and it plays on unsaved.
  start(null);
  coins = walkToCell(g, into, 'the unbound walk into tomb B');
  need(g.screen === 'savein' && tombCount(g.sim) === H, 'the unbound crossing into B opens SAVE IN?');
  keyTo(g, 'KeyQ', 'q');
  need(g.screen === 'play' && g.saveId === null, 'Q on SAVE IN? plays on unsaved');
  wallet = g.wallet - coins;
  h = g;
  for (let loop = 1; loop <= 3; loop++) {
    coins += walkToCell(h, gate, 'the walk back into tomb A');
    offEntry(h, `unbound loop ${loop}`);
    keyTo(h, 'KeyP', 'p');
    need(h.screen === 'pause' && h.saveId === null, `unbound loop ${loop}: the pause is unsaved`);
    keyTo(h, 'Enter', 'Enter');
    need(h.screen === 'savein' && h.saveIn.rows[0].n === 1, `unbound loop ${loop}: SAVE opens SAVE IN? on slot 1`);
    keyTo(h, 'Enter', 'Enter');
    need(h.screen === 'pause' && h.slot === 1 && saveNow(1) !== null && saveNow(1).id === h.saveId, `unbound loop ${loop}: SAVE IN? binds the run to slot 1`);
    h = reload();
    continueSlot(h, 1);
    coins += walkToCell(h, into, 'the walk forward into tomb B');
    holds(h, wallet + coins, `unbound loop ${loop}: TOMB n, the high and the wallet hold at H`);
    unstore(saveKey(1));
  }
}

/**
 * An EMPTY row binds: Enter on it opens NEW RUN SLOT n, whose run writes
 * nothing until its first coin, which writes the slot with no SAVE IN?.
 */
function emptyRowLeg(g, { need, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  clearSaves();
  putSave(1, { id: 'AAAAAAAA', wallet: 5 });
  cleanState(g);
  openTitle(g);
  press('ArrowDown', 'ArrowDown');
  press('Enter', 'Enter');
  need(g.screen === 'newrun' && g.bind === 2, 'Enter on an EMPTY row opens NEW RUN SLOT 2');
  press('Enter', 'Enter');
  need(g.screen === 'play' && g.slot === 2 && g.saveId === null, 'BEGIN from NEW RUN SLOT 2 binds the run to slot 2');
  // Before the coin, a PAUSE and Q, and a reload, leave the slot EMPTY.
  press('KeyP', 'p');
  press('KeyQ', 'q');
  need(g.screen === 'title' && heldSave(2).state === 'absent', 'a PAUSE and Q before the first coin leave the bound slot EMPTY');
  reload();
  need(heldSave(2).state === 'absent', 'a reload before the first coin leaves the bound slot EMPTY');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.slot === 2, 'P returns to the bound run');
  walkToItem(g, firstCoin(g.world));
  need(g.screen === 'play' && saveNow(2) !== null && saveNow(2).wallet === 1 && saveNow(2).id === g.saveId && saveNow(1).wallet === 5,
    'the first coin writes slot 2 with no SAVE IN?');
}

/**
 * An unbound run asks SAVE IN? at its first coin, holding the run: empty rows
 * first, OVERWRITE over a used one, Q to play on unsaved, and SAVE on the
 * unsaved pause. SAVE IN? ignores the play keys. A milestone's tick shows SAVE
 * IN? before the splash, and a tick that ends the run shows none.
 */
function saveInLeg(g, { need, click, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const fresh = () => {
    cleanState(g);
    openTitle(g);
    click('title', 'new');
    click('newrun', 'begin');
  };
  const tap = (sid, which) => softTap(g, click, sid, which);
  // Slot 1 used, slots 2 and 3 empty.
  clearSaves();
  putSave(1, { id: 'AAAAAAAA', wallet: 5, net: 3, high: 3 });
  fresh();
  const run = g.sim, coin = firstCoin(g.world);
  walkToItem(g, coin);
  need(g.screen === 'savein' && g.sim === run && g.wallet === 1 && g.saveId === null, 'N, BEGIN and the first coin hold the run under SAVE IN?');
  need(g.saveIn.order === '231' && g.saveIn.cursor === 0, 'SAVE IN? lists the empty rows first, the cursor on the first');
  const time = run.time;
  for (let i = 0; i < 30; i++) tick(g);
  need(g.screen === 'savein' && run.time === time, 'the run stands still under SAVE IN?');
  const before = savesText();
  press('Space', ' ');
  press('KeyP', 'p');
  press('Enter', 'Enter', true);
  need(g.screen === 'savein' && g.saveId === null && savesText() === before, 'Space, P and an auto-repeated Enter answer nothing on SAVE IN?');
  // A used row asks OVERWRITE SLOT 1?, whose N returns to SAVE IN?.
  press('ArrowDown', 'ArrowDown');
  press('ArrowDown', 'ArrowDown');
  press('Enter', 'Enter');
  need(g.confirm !== null && g.confirm.kind === 'overwrite' && g.confirm.n === 1 && savesText() === before, 'a used row asks OVERWRITE SLOT 1?');
  press('KeyN', 'n');
  need(g.screen === 'savein' && g.confirm === null && savesText() === before, 'N at OVERWRITE returns to SAVE IN?');
  // Picking an empty row stores the wallet the run held at the pick, no more.
  const slot1 = load(saveKey(1));
  tap('savein', 's2');
  need(g.screen === 'play' && g.slot === 2 && saveNow(2) !== null && saveNow(2).id === g.saveId && saveNow(2).wallet === 1
    && load(saveKey(1)) === slot1 && heldSave(3).state === 'absent', 'picking an empty row stores the wallet the run held, no more');

  // OVERWRITE's Y writes that slot alone.
  fresh();
  walkToItem(g, coin);
  need(g.screen === 'savein' && g.saveIn.order === '312', 'SAVE IN? lists slot 3, then the used slots in row order');
  const slot2 = load(saveKey(2));
  tap('savein', 's1');
  need(g.confirm !== null && g.confirm.kind === 'overwrite' && g.confirm.n === 1, 'SLOT 1 asks OVERWRITE SLOT 1?');
  tap('confirm', 'yes');
  need(g.screen === 'play' && g.slot === 1 && saveNow(1).id === g.saveId && g.saveId !== 'AAAAAAAA' && saveNow(1).wallet === 1
    && load(saveKey(2)) === slot2 && heldSave(3).state === 'absent', 'OVERWRITE\'s Y writes that slot alone');

  // Q plays on unsaved, and SAVE IN? asks no more by itself; the unsaved pause's SAVE opens it again.
  fresh();
  walkToItem(g, coin);
  need(g.screen === 'savein', 'the next unbound run\'s first coin asks SAVE IN?');
  const held = savesText();
  tap('savein', 'back');
  need(g.screen === 'play' && g.saveId === null && savesText() === held, 'BACK on SAVE IN? plays on unsaved');
  walkToItem(g, { ...coin, i: 1 });
  need(g.screen === 'play' && g.wallet === 2, 'a dismissed SAVE IN? asks no more by itself');
  draw(g, 0);
  click('play', 'pause');
  draw(g, 0);
  need(g.screen === 'pause' && g.saveId === null && touch.soft('pause', 'save').getBoundingClientRect().width > 0, 'the unsaved pause shows SAVE');
  click('pause', 'save');
  need(g.screen === 'savein' && g.saveIn.from === 'pause', 'SAVE on the unsaved pause opens SAVE IN?');
  press('KeyQ', 'q');
  need(g.screen === 'pause' && g.saveId === null, 'Q returns SAVE IN? to the unsaved pause');

  // A tick that crosses a milestone shows SAVE IN? before the splash, and a tick that ends the run shows none.
  cleanState(g);
  const { ticks } = oneTombOn(g, 99);
  need(g.screen === 'savein' && g.saveIn.splash && g.saveIn.splash.k === 1 && g.saveIn.splash.paid, 'a milestone tick shows SAVE IN? before the splash');
  press('KeyQ', 'q');
  need(g.screen === 'splash' && g.splash.k === 1, 'SAVE IN?\'s answer shows the splash it held back');
  cleanState(g);
  oneTombOn(g, 99, ticks);
  need(g.screen === 'over' && g.saveIn === null, 'a tick that ends the run shows no SAVE IN?');
}

/** A DAMAGED slot reads DAMAGED, binds a run as an EMPTY one does, leads SAVE IN?'s rows and keeps ERASE hidden. */
function damagedLeg(g, { need, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  clearSaves();
  putSave(1, { id: 'AAAAAAAA' });
  store(saveKey(2), '{not json');
  putSave(3, { id: 'CCCCCCCC' });
  cleanState(g);
  openTitle(g);
  need(heldSave(2).state === 'damaged' && ROW_LABEL[heldSave(2).state] === 'DAMAGED', 'a slot holding an unparseable string reads DAMAGED, never EMPTY');
  need(!eraseShows(), 'ERASE stays hidden while a slot is DAMAGED');
  press('KeyN', 'n');
  press('Enter', 'Enter');
  walkToItem(g, firstCoin(g.world));
  need(g.screen === 'savein' && g.saveIn.order === '213', 'SAVE IN? lists the DAMAGED slot among the first rows');
  press('KeyQ', 'q');
  openTitle(g);
  press('ArrowDown', 'ArrowDown');
  press('Enter', 'Enter');
  need(g.screen === 'newrun' && g.bind === 2, 'Enter on a DAMAGED row opens NEW RUN SLOT 2');
  press('Enter', 'Enter');
  walkToItem(g, firstCoin(g.world));
  need(g.screen === 'play' && saveNow(2) !== null && saveNow(2).id === g.saveId, 'a DAMAGED row\'s run takes the slot at its first coin');
}

/** A newer build's record reads NEWER, plays nothing, stays off SAVE IN? and out of erasing, and keeps its text. */
function newerLeg(g, { need, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const newer = JSON.stringify({ v: 2, id: 'NNNNNNNN', save: SAVE_BASE.save, level: 'medium', skins: ['gold'] });
  clearSaves();
  putSave(1, { id: 'AAAAAAAA' });
  store(saveKey(2), newer);
  putSave(3, { id: 'CCCCCCCC' });
  cleanState(g);
  openTitle(g);
  need(heldSave(2).state === 'newer' && ROW_LABEL[heldSave(2).state] === 'NEWER', 'a slot holding a v 2 record reads NEWER');
  press('Digit2', '2');
  press('ArrowDown', 'ArrowDown');
  press('Enter', 'Enter');
  need(g.screen === 'title' && g.confirm === null && g.cursor === 1, 'Enter and the digit of a NEWER row do nothing');
  // ERASE shows beside a NEWER slot, and erasing skips it.
  need(eraseShows(), 'ERASE shows over three slots held');
  press('KeyE', 'e');
  press('ArrowDown', 'ArrowDown');
  need(g.erasing && g.cursor === 2, 'erasing skips the NEWER row');
  press('Digit2', '2');
  need(g.confirm === null, 'a NEWER row\'s digit asks no ERASE');
  press('KeyQ', 'q');
  // SAVE IN? does not list it.
  press('KeyN', 'n');
  press('Enter', 'Enter');
  walkToItem(g, firstCoin(g.world));
  need(g.screen === 'savein' && g.saveIn.order === '13', 'SAVE IN? does not list a NEWER slot');
  press('KeyQ', 'q');
  need(load(saveKey(2)) === newer, 'a NEWER slot\'s stored text is unchanged after the leg');
}

/** Restoring slot n shows slot n, and the open run's own row resumes it. */
function restoreLeg(g, { need, click, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const first = g.world.startPoint().board, X = exitBoard(g.world);
  const one = encodeSave(SELFTEST_CODE, first.x, first.y), two = encodeSave(SELFTEST_CODE, X.x, X.y);
  clearSaves();
  putSave(1, { id: 'AAAAAAAA', save: one, net: 4, high: 7, wallet: 70 });
  putSave(2, { id: 'BBBBBBBB', save: two, net: 30, high: 31, wallet: 310 });
  cleanState(g);
  openTitle(g);
  click('title', 's2');
  const c = g.confirm;
  need(c !== null && c.kind === 'continue' && c.n === 2 && c.held.record.save === two && c.held.record.high === 31 && c.held.record.wallet === 310,
    'slot 2\'s row opens CONTINUE SLOT 2? with its own serial, TOMB n and coins');
  softTap(g, click, 'confirm', 'yes');
  need(g.screen === 'play' && g.slot === 2 && tombCount(g.sim) === 31 && g.sim.net === 30 && g.wallet === 310 && hereCode(g) === two,
    'Y plays slot 2 at its high and wallet');
  // The open run's row resumes it, its burn unchanged.
  const run = g.sim;
  run.burn = BURN_S / 3;
  press('KeyP', 'p');
  press('KeyQ', 'q');
  need(g.screen === 'title' && g.open !== null && g.open.sim === run && g.cursor === 1, 'Q from pause leaves the run open, the cursor on its slot');
  press('Enter', 'Enter');
  need(g.screen === 'play' && g.sim === run && run.burn === BURN_S / 3, 'Enter on the open run\'s own row resumes the same run, its burn unchanged');
  // A code typed on NEW RUN equal to slot 2's serial opens CONTINUE SLOT 2?.
  cleanState(g);
  openTitle(g);
  click('title', 'new');
  withPrompt(two, () => click('newrun', 'type'));
  need(g.screen === 'title' && g.confirm !== null && g.confirm.n === 2 && g.confirm.held.record.save === two,
    'a code typed on NEW RUN equal to slot 2\'s serial opens CONTINUE SLOT 2?');
  press('KeyN', 'n');
}

/**
 * ERASE: absent beside an empty slot; over three used slots, E and a digit, or
 * the touch keys, ask ERASE SLOT n?, which removes that key alone at Y and
 * nothing at N, Q or Esc. Erasing the open run's slot unbinds it.
 */
function eraseLeg(g, { need, click, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const tap = (sid, which) => softTap(g, click, sid, which);
  clearSaves();
  putSave(1, { id: 'AAAAAAAA' });
  putSave(2, { id: 'BBBBBBBB' });
  cleanState(g);
  openTitle(g);
  press('KeyE', 'e');
  need(!g.erasing && g.confirm === null && !eraseShows() && touch.soft('title', 'erase').getBoundingClientRect().width === 0,
    'with a slot EMPTY, E does nothing and E ERASE is absent');
  putSave(3, { id: 'CCCCCCCC' });
  const before = savesText();
  for (const [code, key] of [['KeyN', 'n'], ['KeyQ', 'q'], ['Escape', 'Escape']]) {
    press('KeyE', 'e');
    press('Digit2', '2');
    need(g.confirm !== null && g.confirm.kind === 'erase' && g.confirm.n === 2 && savesText() === before, 'E and a digit open ERASE SLOT 2?');
    press(code, key);
    need(g.screen === 'title' && g.confirm === null && !g.erasing && savesText() === before, `${key} at ERASE SLOT 2? removes nothing`);
  }
  tap('title', 'erase');
  need(g.erasing, 'the ERASE key enters erasing');
  tap('erasing', 'back');
  need(!g.erasing && savesText() === before, 'BACK leaves erasing');
  tap('title', 'erase');
  tap('erasing', 'e2');
  need(g.confirm !== null && g.confirm.kind === 'erase' && g.confirm.n === 2, 'ERASE 2 asks ERASE SLOT 2?');
  tap('confirm', 'yes');
  need(g.screen === 'title' && !g.erasing && heldSave(2).state === 'absent' && saveNow(1).id === 'AAAAAAAA' && saveNow(3).id === 'CCCCCCCC',
    'Y removes that key alone');
  // An erase of the open run's slot unbinds it at Y, and P resumes it unsaved.
  putSave(2, { id: 'BBBBBBBB' });
  openTitle(g);
  press('Digit3', '3');
  press('KeyY', 'y');
  const run = g.sim;
  press('KeyP', 'p');
  press('KeyQ', 'q');
  press('KeyE', 'e');
  press('Digit3', '3');
  press('KeyY', 'y');
  need(heldSave(3).state === 'absent' && g.open !== null && g.open.slot === null && g.open.saveId === null,
    'ERASE of the open run\'s slot unbinds the run at its Y');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim === run && g.saveId === null, 'P resumes the open run unsaved');
}

/**
 * Another tab overwrites, then erases, the first game's slot: each time the
 * first game's next write stores nothing, it plays on unsaved and its next
 * coin asks SAVE IN?.
 */
function otherTabLeg(g, { need, click, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const coin = firstCoin(g.world);
  clearSaves();
  putSave(2, { id: 'BBBBBBBB' });
  putSave(3, { id: 'CCCCCCCC' });
  cleanState(g);
  openTitle(g);
  click('title', 's1');
  click('newrun', 'begin');
  walkToItem(g, coin);
  need(saveNow(1) !== null && saveNow(1).id === g.saveId, 'the first game takes slot 1 at its first coin');
  // The other game overwrites slot 1 under its own id.
  const other = reload();
  keyTo(other, 'KeyN', 'n');
  keyTo(other, 'Enter', 'Enter');
  walkToItem(other, coin);
  keyTo(other, 'Enter', 'Enter');
  keyTo(other, 'KeyY', 'y');
  need(saveNow(1).id === other.saveId && other.saveId !== g.saveId, 'a second game overwrites slot 1 under another id');
  const theirs = load(saveKey(1));
  press('KeyP', 'p');
  need(load(saveKey(1)) === theirs && g.saveId === null && g.slot === null, 'the first game\'s next write stores nothing after another tab\'s overwrite');
  press('KeyP', 'p');
  walkToItem(g, { ...coin, i: 1 });
  need(g.screen === 'savein', 'the unsaved first game\'s next coin asks SAVE IN?');
  // It takes slot 1 back through OVERWRITE; the other game, unsaved at its next write, erases it.
  press('Enter', 'Enter');
  press('KeyY', 'y');
  need(g.screen === 'play' && saveNow(1).id === g.saveId, 'the first game takes slot 1 back through OVERWRITE');
  keyTo(other, 'KeyP', 'p');
  keyTo(other, 'KeyQ', 'q');
  keyTo(other, 'KeyE', 'e');
  keyTo(other, 'Digit1', '1');
  keyTo(other, 'KeyY', 'y');
  need(heldSave(1).state === 'absent' && other.saveId === null, 'the second game erases slot 1');
  press('KeyP', 'p');
  need(heldSave(1).state === 'absent' && g.saveId === null, 'the first game\'s next write stores nothing after another tab\'s erase');
  press('KeyP', 'p');
  walkToItem(g, { ...coin, i: 2 });
  need(g.screen === 'savein', 'the first game\'s next coin asks SAVE IN? again');
  press('KeyQ', 'q');
}

/**
 * The confirm re-reads: OVERWRITE SLOT n? and ERASE SLOT n?, drawn before
 * another game rewrote slot n under another id, redraw at Y with the stored
 * record and write or remove nothing.
 */
function rereadLeg(g, { need, click, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  clearSaves();
  for (const n of SAVE_SLOTS) putSave(n, { id: `${'ABC'[n - 1]}AAAAAAA` });
  cleanState(g);
  openTitle(g);
  click('title', 'new');
  click('newrun', 'begin');
  walkToItem(g, firstCoin(g.world));
  press('Enter', 'Enter');
  need(g.confirm !== null && g.confirm.kind === 'overwrite' && g.confirm.n === 1 && g.confirm.held.record.id === 'AAAAAAAA', 'SAVE IN? asks OVERWRITE SLOT 1?');
  putSave(1, { id: 'DDDDDDDD', wallet: 9 });
  const rewritten = load(saveKey(1));
  press('KeyY', 'y');
  need(g.screen === 'savein' && g.confirm !== null && g.confirm.held.record.id === 'DDDDDDDD' && load(saveKey(1)) === rewritten && g.saveId === null,
    'OVERWRITE redraws at Y with the stored record and writes nothing');
  press('KeyN', 'n');
  press('KeyQ', 'q');
  openTitle(g);
  press('KeyE', 'e');
  press('Digit3', '3');
  need(g.confirm !== null && g.confirm.kind === 'erase' && g.confirm.held.record.id === 'CAAAAAAA', 'E and 3 ask ERASE SLOT 3?');
  putSave(3, { id: 'EEEEEEEE' });
  const third = load(saveKey(3));
  press('KeyY', 'y');
  need(g.confirm !== null && g.confirm.held.record.id === 'EEEEEEEE' && load(saveKey(3)) === third, 'ERASE redraws at Y and removes nothing');
  press('KeyN', 'n');
}

/**
 * The migration steps of the touch leg, from the slot list with no run open.
 * A page reload migrates the old slot, or the seven legacy keys of a HARD save
 * at TOMB 20 with a wallet of 57, to slot 1 once per device.
 */
function legacyLeg(g, { need }) {
  // The stacked world's save difficulty, which a plane save never reads.
  const STACKED = 'infinite-maze.save.difficulty';
  const level = 'hard', key = coinKey(SELFTEST_CODE, level), stranger = coinKey('K7Q2M9XA', level);
  setDifficulty(g, level);
  useCode(g, SELFTEST_CODE);
  const coin = firstCoin(g.world), id = coinId(coin.bd, coin.cell, coin.i), first = g.world.startPoint().board;
  const serial = encodeSave(SELFTEST_CODE, first.x, first.y);
  const twenty = Array.from({ length: 20 }, (_, i) => `0,${-1 - i}`);
  const fresh = () => {
    clearSaves();
    unstore(MIGRATED_KEY);
    unstore(OLD_SLOT_KEY);
    for (const k of Object.values(LEGACY_KEYS)) unstore(k);
  };
  // A device that played before the slots, with another seed's coins, tombs and record beside the save's.
  const oldKeys = ({ save = serial, difficulty = level, run = { save: serial, start: '0,0', solved: twenty } } = {}) => {
    fresh();
    store(LEGACY_KEYS.save, save);
    if (difficulty) store(LEGACY_KEYS.difficulty, difficulty);
    if (run) store(LEGACY_KEYS.run, JSON.stringify(run));
    store(LEGACY_KEYS.wallet, '57');
    store(LEGACY_KEYS.coins, JSON.stringify({ [key]: [id], [stranger]: ['1,1,1'] }));
    store(LEGACY_KEYS.tombs, JSON.stringify({ [key]: ['0,0'], [stranger]: ['5,5'] }));
    store(LEGACY_KEYS.paid, JSON.stringify({ [key]: 20, [stranger]: 9 }));
  };
  const gone = () => Object.values(LEGACY_KEYS).every((k) => load(k) === null);
  // A page reload migrates, and slot 1's row asks CONTINUE SLOT 1? over the migrated save.
  const ask = () => {
    const h = reload();
    keyTo(h, 'Digit1', '1');
    return h;
  };

  // The old slot, of TOMB 20 and a record of 50, migrates to slot 1 at net 20 and high 50 and stays as
  // stored, for older builds; erasing every slot then never brings it back.
  fresh();
  const old = JSON.stringify({
    id: 'QQQQQQQQ', save: serial, level, start: '0,0', solved: twenty, wallet: 57, coins: [], tombs: ['0,0'], record: 50, continues: 1, recent: [],
  });
  store(OLD_SLOT_KEY, old);
  reload();
  const moved = saveNow(1);
  need(moved !== null && moved.id === 'QQQQQQQQ' && moved.net === 20 && moved.high === 50 && moved.wallet === 57 && moved.continues === 1
    && load(OLD_SLOT_KEY) === old && load(MIGRATED_KEY) === '1', 'the old slot migrates to slot 1 at net 20 and high 50 and stays as stored');
  clearSaves();
  reload();
  need(heldSave(1).state === 'absent' && load(OLD_SLOT_KEY) === old, 'erasing every slot never brings the old save back');

  // The legacy keys migrate once, with the device wallet, and go.
  oldKeys();
  let h = ask();
  need(h.confirm !== null, 'RESUME over a legacy save asks CONTINUE?');
  const slot = h.confirm.held.record;
  need(slot.wallet === 57 && slot.net === 20 && slot.high === 20 && slot.level === level, 'a legacy save keeps its wallet, TOMB and difficulty');
  need(load(MIGRATED_KEY) === '1' && gone(), 'a legacy save adopts the device wallet once');
  keyTo(h, 'KeyY', 'y');
  need(h.screen === 'play' && h.wallet === 57 && tombCount(h.sim) === 20 && h.difficulty === level, 'Y plays a legacy save at its wallet, TOMB and difficulty');

  // A save with no difficulty beside it plays at ULTIMATE, the 6x4 world, whatever the stacked world's save left.
  oldKeys({ difficulty: null });
  store(STACKED, 'easy');
  h = ask();
  need(h.confirm.held.record.level === 'ultimate', 'a legacy save with no stored difficulty adopts at ULTIMATE');
  keyTo(h, 'KeyY', 'y');
  need(h.screen === 'play' && h.difficulty === 'ultimate' && h.world.difficulty === 'ultimate', 'Y plays a legacy save with no stored difficulty at ULTIMATE');
  unstore(STACKED);

  // The run counts only when it names the save.
  // A save in tomb (1, 0) with no run starts there, as a typed save code does, so its tombs can count.
  const board = boardCoords(1, 0, 0, g.world.size), elsewhere = encodeSave(SELFTEST_CODE, board.x, board.y);
  oldKeys({ save: elsewhere, run: null });
  h = ask();
  need(h.confirm.held.record.net === 0 && h.confirm.held.record.start === '1,0', 'a legacy save without a run resumes at its own tomb');
  keyTo(h, 'KeyY', 'y');
  need(h.screen === 'play' && h.sim.net === 0 && h.sim.start.u === 1 && h.sim.start.v === 0 && h.point.start === '1,0',
    'Y plays a legacy save without a run from its own tomb');
  oldKeys({ run: { save: encodeSave(SELFTEST_CODE, first.x + 1, first.y), start: '0,0', solved: twenty } });
  h = ask();
  need(h.confirm.held.record.net === 0, 'a legacy run naming another save migrates at net 0');
  fresh();
}

const DIRS = {
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
};
const DIR_BITS = { l: KEY.L, r: KEY.R, u: KEY.U, d: KEY.D };
const JUMP_KEYS = ['Space', 'KeyZ'];
// NEW RUN's keys that step the difficulty setting, stopping at the ends.
const SETTING_STEP = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
// The digit keys of the three slot rows.
const SLOT_DIGITS = { Digit1: 1, Digit2: 2, Digit3: 3 };
// The slot list's cursor rows: slots 1 to 3, then the N NEW RUN row.
const NEW_ROW = 3;

// ULTIMATE, the 6x4 world, keeps the bare seed code, so bests from before
// difficulties carry over.
function bestKey(code, difficulty) {
  return difficulty === 'ultimate' ? code : `${code}:${difficultyLabel(difficulty)}`;
}

function readBest(code, difficulty) {
  try { return JSON.parse(load(KEY_BEST) || '{}')[bestKey(code, difficulty)] ?? null; } catch { return null; }
}

/** Keeps the largest high any save reached per seed and difficulty. */
function writeBest(code, difficulty, high) {
  const key = bestKey(code, difficulty);
  let all = {};
  try { all = JSON.parse(load(KEY_BEST) || '{}'); } catch { all = {}; }
  if (all[key] === undefined || high > all[key]) { all[key] = high; store(KEY_BEST, JSON.stringify(all)); }
}

/** The economy of a new run: bound to slot `slot` or none, no save, wallet 0. */
function cleanState(g, slot = null) {
  Object.assign(g, { slot, saveId: null, point: null, wallet: 0, asked: false });
}

/** The fields of the game's economy, which a run left open takes with it. */
function economyOf(g) {
  const { slot, saveId, point, wallet, asked } = g;
  return { slot, saveId, point, wallet, asked };
}

/**
 * A tick's one write and its pay: the tick took `coins`, the high rose from
 * `was`, `entered` an entry board and `moved` changed tomb or took a jar. A run
 * holding a save writes on any of them: an entry moves the serial to the entry
 * save point, and the rest keep it. A bound run's first coin or counted tomb
 * takes its slot at the entry save point; an unbound run pays in memory.
 * Returns the pay, { earned, seen }, or null when the tick earned nothing.
 */
function tickSave(g, coins, was, entered, moved) {
  const s = g.sim, earns = coins > 0 || tombCount(s) > was;
  let out = null;
  if (g.saveId !== null) {
    if (entered) out = writeAt(g, s.entry, { coins, was });
    else if (earns || moved) out = commit(g, g.point, { coins, was });
  } else if (earns) {
    out = g.slot !== null ? writeAt(g, s.entry, { bind: {}, coins, was }) : payInMemory(g, coins, was);
  }
  if (!earns) return null;
  g.earned += out.earned;
  return out;
}

/** State shared by input, tick and draw. */
function createGame() {
  // A visit ends whenever the screen is written, even back to the same one.
  let screen = 'title', visit = 0;
  return {
    get screen() { return screen; },
    set screen(next) { screen = next; visit++; },
    get visit() { return visit; },
    // A game starts clean: no slot, no save and wallet 0. A run binds to slot
    // `slot`, takes it under `saveId` and writes its serial and net at `point`;
    // `asked` holds once SAVE IN? was dismissed.
    slot: null, saveId: null, point: null, wallet: 0, asked: false,
    // The slot list: the cursor's row, 0 to 2 the slots and NEW_ROW the N NEW
    // RUN row, whose lit choice `pick` is 'new' or 'erase', and whether it is
    // erasing.
    cursor: homeRow({ open: null }), pick: 'new', erasing: false,
    // The slot NEW RUN binds its run to, or null for an unbound run.
    bind: null,
    // A confirm: { kind: 'continue' | 'erase' | 'overwrite', n, held }, slot n
    // as drawn; null when none is asked.
    confirm: null,
    // SAVE IN?: { at, from, splash, rows, cursor, order } while it holds the run.
    saveIn: null,
    // The coins the wallet has gained since the run began; Continue carries them.
    earned: 0,
    audio: createAudio(), keys: new Set(), cam: { x: 0, y: 0 },
    // Key edges since the last tick: KEY bits pressed and released, and a jump press.
    press: 0, release: 0, jump: false,
    code: firstSeed(),
    // The side of the d-pad: 'left' or 'right'.
    side: padSide(load(KEY_PAD)),
    // The title's setting; `world` is always built at it.
    difficulty: storedDifficulty(KEY_DIFFICULTY, 'medium'),
    world: null, renderer: null, sim: null, preview: null,
    // The run left for the title by Q: { slot, saveId, point, wallet, asked, code, world, renderer, preview, sim }.
    open: null,
    // The milestone the splash shows: { k, paid }, where paid is whether this crossing paid.
    splash: null,
    typing: null, note: '', footFrame: -1, climbFrame: -1,
    // The tomb { u, v } the pause map frames, and its model.
    frame: { u: 0, v: 0 }, pauseMap: null, pausedAt: null,
  };
}

/** The seed NEW RUN shows first: the lowest used slot's, else a rolled one. */
function firstSeed() {
  for (const n of SAVE_SLOTS) {
    const held = heldSave(n);
    if (held.state === 'valid') return decodeSave(held.record.save).code;
  }
  return rollCode();
}

/** A game as a page load makes one: the migration runs first, before the first title frame. */
function newGame() {
  migrateSaves(slotIo);
  return createGame();
}

// Title camera: the explorer's feet stand at titleFeet of the layout in force,
// clear of the menu panel and the key columns.
function titleCam(g) {
  const [x, y] = feet(g.preview), [fx, fy] = titleFeet(touch && touch.lay);
  g.cam.x = x + VIEW_W / 2 - fx;
  g.cam.y = y + fy - VIEW_H / 2;
}

function useCode(g, code) {
  g.code = code;
  g.world = createWorld(code, { difficulty: g.difficulty });
  g.renderer = createRenderer(view, g.world, display);
  g.preview = createSim(g.world, g.world.startPoint());
  titleCam(g);
}

/** Moves the setting, storing it; the caller rebuilds the world when needed. */
function keepSetting(g, difficulty) {
  g.difficulty = difficulty;
  store(KEY_DIFFICULTY, difficulty);
}

/** Changes the setting and rebuilds the title preview at it. */
function setDifficulty(g, difficulty) {
  if (difficulty === g.difficulty) return;
  keepSetting(g, difficulty);
  useCode(g, g.code);
}

function play(g) {
  snapCam(g.cam, g.sim);
  g.screen = 'play';
  g.note = '';
  g.press = 0;
  g.release = 0;
  g.jump = false;
}

/**
 * Starts a new run at save position p, or at tomb (0, 0)'s first entry when p
 * is null. The new sim keeps the coins and jars taken in the tomb it starts in
 * and the tomb before it only when the `carry` holds them: the end screen's
 * Continue carries them and a restore of a save unpacks them. Any other start
 * takes none, and every coin and jar lies back.
 */
function begin(g, p = null, carry = null) {
  let start = g.world.startPoint();
  if (p !== null) {
    const { x, y } = boardOfPos(p);
    start = g.world.resumePoint(x, y);
  }
  g.sim = createSim(g.world, start, carry);
  if (!carry) g.earned = 0;
  g.open = null;
  g.confirm = null;
  g.saveIn = null;
  play(g);
}

/**
 * Begins at save position p; with a `run`, its entry save point, high, start
 * tomb, continue count and recent takes carry over.
 */
function beginSaved(g, p, run) {
  begin(g, p, run && {
    time: 0, entry: run.entry, high: run.high, start: run.start, lastEntry: p, continues: run.continues,
    recent: run.recent, collected: run.collected, jars: run.jars,
  });
  g.earned = 0;
}

/** BEGIN: a run from tomb (0, 0) with a clean economy, bound to the slot NEW RUN names. */
function beginClean(g) {
  cleanState(g, g.bind);
  g.bind = null;
  begin(g);
}

/**
 * Restores slot n's record `rec` into memory and begins its run at the
 * serial's board, at the record's difficulty, with its start tomb, net, high,
 * wallet, continue count and recent takes, closing any open run. The run is
 * bound to slot n under the record's id. The setting follows.
 */
function restore(g, n, rec) {
  const at = decodeSave(rec.save);
  keepSetting(g, rec.level);
  if (at.code !== g.code || g.world.difficulty !== rec.level) useCode(g, at.code);
  Object.assign(g, { slot: n, saveId: rec.id, point: { save: rec.save, net: rec.net, start: rec.start }, wallet: rec.wallet, asked: false });
  const [u, v] = rec.start.split(',').map(Number);
  beginSaved(g, at.p, { entry: { p: at.p, net: rec.net }, high: rec.high, start: { u, v }, continues: rec.continues, ...unpackRecent(g.world, rec.recent) });
}

/** Returns to the open run unchanged; the setting follows it. */
function resumeOpen(g) {
  const o = g.open;
  g.open = null;
  Object.assign(g, economyOf(o), { code: o.code, world: o.world, renderer: o.renderer, preview: o.preview, sim: o.sim });
  keepSetting(g, o.world.difficulty);
  play(g);
}

/**
 * P, Esc and Start on the slot list: back to the open run, or with none open,
 * the lit slot row as Enter plays it. On the N NEW RUN row they do nothing.
 */
function resume(g) {
  if (g.open) resumeOpen(g);
  else if (g.cursor < NEW_ROW) playRow(g, g.cursor + 1);
}

/**
 * Plays slot row n: the open run's own row resumes it; a used row asks
 * CONTINUE SLOT n?; an empty or damaged row opens NEW RUN bound to it; a newer
 * build's row does nothing.
 */
function playRow(g, n) {
  if (g.open && g.open.slot === n) {
    resumeOpen(g);
    return;
  }
  const held = heldSave(n);
  if (held.state === 'valid') g.confirm = { kind: 'continue', n, held };
  else if (isFree(held)) openNewRun(g, n);
}

/** Enter on the slot list: the lit slot row, or on the last row NEW RUN or, lit, erasing. */
function enterRow(g) {
  if (g.cursor < NEW_ROW) playRow(g, g.cursor + 1);
  else if (g.pick === 'erase' && eraseShows()) startErasing(g);
  else openNewRun(g, null);
}

/** Opens NEW RUN, bound to slot n or, with n null, unbound. */
function openNewRun(g, n) {
  g.screen = 'newrun';
  g.bind = n;
  g.typing = null;
  g.note = '';
}

/** Moves the cursor to the used rows for erasing, while ERASE shows. */
function startErasing(g) {
  if (!eraseShows()) return;
  g.erasing = true;
  g.cursor = Number(usedRows()[0]) - 1;
}

/** Asks ERASE SLOT n? over a used row; any other row does nothing. */
function askErase(g, n) {
  const held = heldSave(n);
  if (held.state === 'valid') g.confirm = { kind: 'erase', n, held };
}

/**
 * Answers CONTINUE SLOT n? and ERASE SLOT n?: Y and Enter are yes; N, Q and Esc
 * no, which returns to the slot list. Nothing else answers, and no repeat.
 */
function confirmKey(g, e) {
  if (e.repeat) return;
  if (e.code === 'KeyY' || e.key === 'Enter') {
    const c = g.confirm;
    if (c.kind === 'erase') {
      eraseYes(g, c);
      return;
    }
    g.confirm = null;
    restore(g, c.n, c.held.record);
  } else if (e.code === 'KeyN' || e.code === 'KeyQ' || e.key === 'Escape') {
    g.confirm = null;
    g.erasing = false;
  }
}

/**
 * ERASE SLOT n?'s yes removes the slot's key while it holds the record drawn.
 * A record under another id redraws the confirm; an empty, damaged or newer
 * key returns to the slot list. An erase of the open run's slot unbinds that
 * run at once.
 */
function eraseYes(g, c) {
  const out = eraseSave(slotIo, saveKey(c.n), c.held.record.id);
  if (!out.ok && out.held.state === 'valid') {
    g.confirm = { ...c, held: out.held };
    return;
  }
  g.confirm = null;
  g.erasing = false;
  if (!out.ok) return;
  g.cursor = c.n - 1;
  if (g.open && g.open.slot === c.n) Object.assign(g.open, { slot: null, saveId: null, point: null, asked: false });
}

function hereCode(g) {
  return encodeSave(g.code, g.sim.bd.x, g.sim.bd.y);
}

function entryCode(g) {
  const { x, y } = boardOfPos(g.sim.lastEntry);
  return encodeSave(g.code, x, y);
}

/**
 * NEW RUN's typed code: a used slot's serial asks CONTINUE SLOT n? over the
 * first such slot; any other save code starts a run at its board and a seed
 * becomes the shown seed, either keeping NEW RUN's binding.
 */
function submitTyped(g) {
  const save = decodeSave(g.typing);
  if (save) {
    g.typing = null;
    // A code carries no count or coins: only a slot's own serial restores its save.
    const n = SAVE_SLOTS.find((k) => {
      const held = heldSave(k), kept = held.state === 'valid' && decodeSave(held.record.save);
      return kept && kept.code === save.code && kept.p === save.p;
    });
    if (n !== undefined) {
      if (save.code !== g.code) useCode(g, save.code);
      g.screen = 'title';
      g.bind = null;
      g.confirm = { kind: 'continue', n, held: heldSave(n) };
      return;
    }
    cleanState(g, g.bind);
    g.bind = null;
    if (save.code !== g.code) useCode(g, save.code);
    beginSaved(g, save.p, null);
    return;
  }
  const c = parseCode(g.typing);
  if (c) { useCode(g, c); g.typing = null; g.note = ''; return; }
  g.note = 'NOT A SEED OR SAVE CODE';
}

function typingKey(g, e) {
  if (e.key === 'Enter') submitTyped(g);
  else if (e.key === 'Escape') { g.typing = null; g.note = ''; }
  else if (e.key === 'Backspace') g.typing = g.typing.slice(0, -1);
  else if (/^[0-9A-Za-z:\-]$/.test(e.key) && g.typing.length < TYPED_MAX) g.typing += e.key.toUpperCase();
}

/** Whether the screen visit now showing is still on; true until `g.screen` is written. */
function visitLive(g) {
  const visit = g.visit;
  return () => g.visit === visit;
}

/**
 * The slot list: Up and Down move the cursor over the four rows and stop at the
 * ends; Left and Right choose NEW RUN or ERASE on the last. Enter plays the lit
 * row, and the digits, N and E act at once. Space does nothing.
 */
function titleKey(g, e) {
  if (g.confirm) { confirmKey(g, e); return; }
  if (g.erasing) { erasingKey(g, e); return; }
  const dir = DIRS[e.code];
  if (dir === 'u' || dir === 'd') g.cursor = Math.max(0, Math.min(NEW_ROW, g.cursor + (dir === 'd' ? 1 : -1)));
  else if (dir) { if (g.cursor === NEW_ROW && eraseShows()) g.pick = dir === 'r' ? 'erase' : 'new'; }
  else if (e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }
  else if (e.repeat) return;
  else if (e.key === 'Enter') enterRow(g);
  else if (SLOT_DIGITS[e.code]) playRow(g, SLOT_DIGITS[e.code]);
  else if (e.code === 'KeyN') openNewRun(g, null);
  else if (e.code === 'KeyE') startErasing(g);
}

/** Erasing: Up and Down over the used rows; Enter or a used row's digit asks ERASE SLOT n?; N, Q and Esc go back. */
function erasingKey(g, e) {
  const dir = DIRS[e.code];
  if (dir === 'u' || dir === 'd') {
    const rows = usedRows(), at = rows.indexOf(String(g.cursor + 1));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (dir === 'd' ? 1 : -1)))];
    if (next) g.cursor = Number(next) - 1;
  } else if (e.repeat) return;
  else if (e.key === 'Enter') askErase(g, g.cursor + 1);
  else if (SLOT_DIGITS[e.code]) askErase(g, SLOT_DIGITS[e.code]);
  else if (e.code === 'KeyN' || e.code === 'KeyQ' || e.key === 'Escape') g.erasing = false;
}

/**
 * NEW RUN: Enter and Space begin the shown seed at tomb 0; L cycles the
 * difficulty and Left and Right step it; R rolls a new seed; T opens code
 * entry; Q goes back to the slot list and drops the binding.
 */
function newRunKey(g, e) {
  if (g.typing !== null) { typingKey(g, e); return; }
  const at = DIFFICULTIES.indexOf(g.difficulty);
  if ((e.key === 'Enter' || e.code === 'Space') && !e.repeat) beginClean(g);
  else if (e.code === 'KeyQ') { g.screen = 'title'; g.bind = null; g.note = ''; }
  else if (e.code === 'KeyR') { useCode(g, rollCode()); g.note = ''; }
  else if (e.code === 'KeyT') { g.typing = ''; g.note = ''; }
  else if (e.code === 'KeyL') setDifficulty(g, DIFFICULTIES[(at + 1) % DIFFICULTIES.length]);
  else if (SETTING_STEP[e.code]) {
    setDifficulty(g, DIFFICULTIES[Math.max(0, Math.min(DIFFICULTIES.length - 1, at + SETTING_STEP[e.code]))]);
  }
}

function playKey(g, e) {
  if (e.code === 'KeyP' || e.key === 'Escape') {
    g.screen = 'pause';
    g.frame = frameOf(g.sim.bd, g.world.size);
    g.pauseMap = null;
    g.pausedAt = null;
    writeAt(g, g.sim.here);
    return;
  }
  if (DIRS[e.code]) {
    g.keys.add(DIRS[e.code]);
    if (!e.repeat) g.press |= DIR_BITS[DIRS[e.code]];
  }
  if (JUMP_KEYS.includes(e.code) && !e.repeat) g.jump = true;
}

/** Where the slot list's cursor starts: the open run's slot, else the first used slot, else slot 1. */
function homeRow(g) {
  if (g.open && g.open.slot !== null) return g.open.slot - 1;
  const used = usedRows();
  return used ? Number(used[0]) - 1 : 0;
}

/** Shows the slot list from another screen: the cursor at its home row and NEW RUN lit on the last. */
function toTitle(g) {
  Object.assign(g, { cursor: homeRow(g), pick: 'new', erasing: false, confirm: null, typing: null, bind: null });
  g.screen = 'title';
  titleCam(g);
}

/** Goes to the title with the run open: RESUME there returns to it unchanged. */
function leaveOpen(g) {
  g.open = { ...economyOf(g), code: g.code, world: g.world, renderer: g.renderer, preview: g.preview, sim: g.sim };
  toTitle(g);
}

// g.copied: the copy status the pause or end screen shows, cleared on leaving it.
function pauseKey(g, e) {
  if (e.code === 'KeyP' || e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }
  else if (e.code === 'KeyQ') {
    leaveOpen(g);
    g.copied = '';
  } else if (e.code === 'KeyC') {
    copyWithStatus(globalThis.navigator.clipboard, hereCode(g), (status) => { g.copied = status; }, visitLive(g));
  } else if (e.code === 'KeyH') {
    if (!e.repeat) {
      g.side = g.side === 'left' ? 'right' : 'left';
      store(KEY_PAD, g.side);
    }
  } else if (e.key === 'Enter') {
    // An unsaved run's SAVE asks SAVE IN?, which binds at the explorer's board.
    if (!e.repeat && g.saveId === null) openSaveIn(g, g.sim.here);
  } else if (DIRS[e.code] && !e.repeat) g.frame = panFrame(g.frame, DIRS[e.code]);
}

function overKey(g, e) {
  const s = g.sim;
  if (e.key === 'Enter' || (e.code === 'Space' && !e.repeat)) {
    g.copied = '';
    begin(g, s.lastEntry, { ...runCarry(s), continues: s.continues + 1 });
  } else if (e.code === 'KeyQ' || e.key === 'Escape') { g.copied = ''; toTitle(g); }
  else if (e.code === 'KeyC') {
    copyWithStatus(globalThis.navigator.clipboard, entryCode(g), (status) => { g.copied = status; }, visitLive(g));
  }
}

// Enter continues and Q leaves the run open on the title. P and Esc do nothing, and
// no repeat counts, so neither a pause press nor a held key skips the screen.
function splashKey(g, e) {
  if (e.repeat) return;
  if (e.key === 'Enter') {
    g.splash = null;
    play(g);
  } else if (e.code === 'KeyQ') {
    g.splash = null;
    leaveOpen(g);
  }
}

/** SAVE IN?'s rows as { n, held }: every slot but a newer build's, empty and damaged first, each kind in slot order. */
function saveInRows() {
  const free = [], used = [];
  for (const n of SAVE_SLOTS) {
    const held = heldSave(n);
    if (isFree(held)) free.push({ n, held });
    else if (held.state === 'valid') used.push({ n, held });
  }
  return [...free, ...used];
}

/**
 * Holds the run under SAVE IN?, which binds it at save point `at` to the slot
 * the player picks, and returns whether it opened: it does not while the
 * latest write failed or with no row to list. `splash` is the milestone the
 * tick held back, shown once SAVE IN? is answered.
 */
function openSaveIn(g, at, splash = null) {
  const rows = saveInRows();
  if (!rows.length || storage.failed()) return false;
  g.saveIn = { at, from: g.screen, splash, rows, cursor: 0, order: rows.map((r) => r.n).join('') };
  g.screen = 'savein';
  return true;
}

/** Redraws SAVE IN?'s rows from storage, the cursor on the first; with none left, the run plays on unsaved. */
function redrawSaveIn(g) {
  const rows = saveInRows();
  if (!rows.length) {
    closeSaveIn(g);
    return;
  }
  Object.assign(g.saveIn, { rows, cursor: 0, order: rows.map((r) => r.n).join('') });
}

/** Leaves SAVE IN? for the screen it held: pause, or play and the milestone splash it held back. */
function closeSaveIn(g) {
  const { from, splash } = g.saveIn;
  g.saveIn = null;
  g.confirm = null;
  if (from === 'pause') {
    g.screen = 'pause';
    return;
  }
  play(g);
  if (splash) showSplash(g, splash.k, splash.paid);
}

/** Whether a slot's state `now` differs from the one a confirm drew: emptied, filled or under another id. */
function changed(drawn, now) {
  if (isFree(drawn)) return !isFree(now);
  return now.state !== 'valid' || now.record.id !== drawn.record.id;
}

/**
 * Picks SAVE IN?'s row: a slot that changed since it was drawn redraws the
 * rows; an empty or damaged one binds the run and writes it; a used one asks
 * OVERWRITE SLOT n?.
 */
function pickRow(g, row) {
  if (!row) return;
  const held = heldSave(row.n);
  if (changed(row.held, held)) {
    redrawSaveIn(g);
    return;
  }
  if (!isFree(held)) {
    g.confirm = { kind: 'overwrite', n: row.n, held };
    return;
  }
  g.slot = row.n;
  if (writeAt(g, g.saveIn.at, { bind: {} }).ok) closeSaveIn(g);
  else redrawSaveIn(g);
}

/**
 * OVERWRITE SLOT n?'s yes binds the run there under a fresh id while the slot
 * holds the record drawn. A record under another id redraws the confirm; an
 * emptied or newer slot returns to SAVE IN?.
 */
function overwriteYes(g) {
  const c = g.confirm;
  g.slot = c.n;
  const out = writeAt(g, g.saveIn.at, { bind: { over: c.held.record.id } });
  if (out.ok) closeSaveIn(g);
  else if (out.held.state === 'valid') g.confirm = { ...c, held: out.held };
  else {
    g.confirm = null;
    redrawSaveIn(g);
  }
}

/**
 * SAVE IN?: Up and Down move the cursor over its rows, and Enter or a listed
 * slot's digit picks; Q and Esc play on unsaved. OVERWRITE SLOT n? takes Y and
 * Enter for yes and N, Q and Esc for no, back to SAVE IN?. SAVE IN? opens
 * mid-play, so both ignore Space, P and every repeated key.
 */
function saveInKey(g, e) {
  if (e.repeat) return;
  const si = g.saveIn;
  if (g.confirm) {
    if (e.code === 'KeyY' || e.key === 'Enter') overwriteYes(g);
    else if (e.code === 'KeyN' || e.code === 'KeyQ' || e.key === 'Escape') g.confirm = null;
    return;
  }
  const dir = DIRS[e.code];
  if (dir === 'u' || dir === 'd') si.cursor = Math.max(0, Math.min(si.rows.length - 1, si.cursor + (dir === 'd' ? 1 : -1)));
  else if (e.key === 'Enter') pickRow(g, si.rows[si.cursor]);
  else if (SLOT_DIGITS[e.code]) pickRow(g, si.rows.find((r) => r.n === SLOT_DIGITS[e.code]));
  else if (e.code === 'KeyQ' || e.key === 'Escape') {
    // Dismissed in play, SAVE IN? asks no more by itself.
    if (si.from === 'play') g.asked = true;
    closeSaveIn(g);
  }
}

const SCREEN_KEYS = {
  title: titleKey, newrun: newRunKey, play: playKey, savein: saveInKey, pause: pauseKey, over: overKey, splash: splashKey,
};

function onKeyDown(g, e) {
  g.audio.start();
  if (DIRS[e.code] || e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyM' && g.typing === null) { g.audio.toggleMute(); return; }
  SCREEN_KEYS[g.screen](g, e);
}

function stepSim(g) {
  const h = (g.keys.has('r') ? 1 : 0) - (g.keys.has('l') ? 1 : 0);
  const v = (g.keys.has('u') ? 1 : 0) - (g.keys.has('d') ? 1 : 0);
  step(g.sim, h, v, g.jump, { press: g.press, release: g.release });
  g.press = 0;
  g.release = 0;
  g.jump = false;
}

function handleEvents(g) {
  const s = g.sim;
  for (const ev of s.events) {
    if (ev === 'relight') { g.audio.play('relight'); g.audio.relight(); }
    else if (ev === 'ember' || ev === 'over') g.audio.play(ev);
    else if (ev === 'coin') g.audio.play('coin');
    if (ev === 'solved') { g.audio.play('band'); writeBest(g.code, g.world.difficulty, tombCount(s)); }
    if (ev === 'seam') g.world.retain(s.bd.u, s.bd.v);
  }
}

/** Footsteps, ladder creaks, low-burn sputter and music intensity. */
function soundCues(g) {
  const s = g.sim;
  const { anim, frame } = pose(s);
  const walking = anim === 'run' || anim === 'gallery';
  if (walking && frame % 4 === 0 && frame !== g.footFrame) g.audio.play('step');
  g.footFrame = walking ? frame : -1;
  if (anim === 'climb' && frame % 2 === 0 && frame !== g.climbFrame) g.audio.play('creak');
  g.climbFrame = anim === 'climb' ? frame : -1;
  const frac = s.burn / BURN_S;
  if (s.burn > 0 && frac < 0.2 && Math.random() < 0.015 + 0.12 * (0.2 - frac)) g.audio.play('sputter');
  g.audio.setIntensity(s.burn > 0 ? 1 - frac : 1);
}

function endRun(g) {
  g.screen = 'over';
  writeBest(g.code, g.world.difficulty, tombCount(g.sim));
  writeAt(g, g.sim.entry);
}

/** Shows the splash for milestone k and stores the save, as PAUSE does. */
function showSplash(g, k, paid) {
  g.screen = 'splash';
  g.splash = { k, paid };
  writeAt(g, g.sim.here);
}

/**
 * The milestone a tick reached, as { k, paid }, or null; `was` and `count` are
 * the high before and after the tick, and `seen` the high the pay rose from,
 * so a crossing the save already paid shows the splash unpaid.
 */
function milestoneHit(was, count, seen) {
  const k = Math.floor(count / MILESTONE);
  if (k <= Math.floor(was / MILESTONE)) return null;
  return { k, paid: seen < k * MILESTONE };
}

function tick(g) {
  if (g.screen !== 'play') return;
  const s = g.sim;
  const was = tombCount(s), jars = s.jars.size, lead = s.recent[0];
  stepSim(g);
  // Each coin the step takes pushes one 'coin' event, which a drop of the tomb the explorer left does not undo.
  // A step that changes tomb drops ids, so the jar count alone cannot tell a take there; the change writes anyway.
  const coins = s.events.filter((ev) => ev === 'coin').length, entered = s.events.includes('entry');
  handleEvents(g);
  const pay = tickSave(g, coins, was, entered, s.recent[0] !== lead || s.jars.size > jars);
  const hit = pay && milestoneHit(was, tombCount(s), pay.seen);
  soundCues(g);
  followCam(g.cam, g.sim);
  // A run that ends on the milestone's tick shows the end screen; the payout stands. An unsaved run's
  // coin or counted tomb asks SAVE IN?, which shows the milestone's splash once answered.
  if (g.sim.state === 'over') endRun(g);
  else if (pay && g.saveId === null && !g.asked && openSaveIn(g, s.entry, hit)) return;
  else if (hit) showSplash(g, hit.k, hit.paid);
}

/** The best tomb NEW RUN shows: the shown seed's, at the setting. */
function titleBest(g) {
  return readBest(g.code, g.difficulty);
}

/** The title's backdrop: the preview explorer under a veil, the game's name and the SAVES OFF warning. */
function titleScene(g, t) {
  const r = g.renderer;
  r.scene(g.preview, g.cam, t);
  r.ctx.fillStyle = shade(0.45);
  r.ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  if (storage.failed()) r.text('SAVES OFF: COPY YOUR CODE', VIEW_W / 2, 4, 'o', { align: 'center' });
  r.text('INFINITE MAZE', VIEW_W / 2, 30, 'm', { align: 'center', scale: 2 });
}

/** The cursor's bar behind the row at y: x to x + w, 11 px tall, edged gold on the left. */
function bar(r, x, y, w) {
  r.ctx.fillStyle = PALETTE[3];
  r.ctx.fillRect(x, y - 2, w, 11);
  r.ctx.fillStyle = PALETTE[0x16];
  r.ctx.fillRect(x, y - 2, 2, 11);
}

let coinSprite = null;

/**
 * Slot n's row at y: its number, then EMPTY, DAMAGED or NEWER, or the
 * record's level, TOMB n (its high) and the coin sprite before the wallet,
 * which ends at x 248. A lit row stands on the cursor's bar.
 */
function slotRow(g, held, n, y, lit, num = true) {
  const r = g.renderer, ink = lit ? 'm' : 'b';
  if (lit) bar(r, 65, y, 190);
  if (num) r.text(String(n), 72, y, ink);
  if (held.state !== 'valid') {
    r.text(ROW_LABEL[held.state], 84, y, lit ? 'm' : held.state === 'damaged' ? 'o' : '7');
    return;
  }
  const { level, high, wallet } = held.record, count = String(wallet);
  r.text(difficultyLabel(level), 84, y, ink);
  r.text(`TOMB ${high}`, 138, y, ink);
  r.text(count, 248, y, ink, { align: 'right' });
  coinSprite = coinSprite || spriteCanvas(COIN);
  r.ctx.drawImage(coinSprite, 248 - textWidth(count) - 2 * (FONT_W + 1), y);
}

// The slot list's rows stand 14 px apart from y 64, the N NEW RUN row 4 px
// lower. Its panel spans y 54..138, 54..124 in touch mode, which draws no hint.
const ROW_Y = [64, 78, 92, 110];

/** The slot list, or the CONTINUE SLOT n? or ERASE SLOT n? it asks. */
function drawTitle(g, t) {
  titleScene(g, t);
  if (g.confirm) {
    drawSlotConfirm(g);
    return;
  }
  const r = g.renderer, touchOn = touch && touch.on;
  r.panel(62, 54, 196, touchOn ? 70 : 84);
  for (const n of SAVE_SLOTS) slotRow(g, heldSave(n), n, ROW_Y[n - 1], g.cursor === n - 1);
  // N NEW RUN, and E ERASE ending at x 248 while ERASE shows; the bar lights the lit choice.
  const y = ROW_Y[NEW_ROW], erase = eraseShows(), lit = g.cursor === NEW_ROW && !g.erasing;
  const litErase = lit && erase && g.pick === 'erase', litNew = lit && !litErase;
  if (litNew) bar(r, 65, y, erase ? 66 : 190);
  if (litErase) bar(r, 199, y, 56);
  r.text('N', 72, y, litNew ? 'm' : 'b');
  r.text('NEW RUN', 84, y, litNew ? 'm' : 'i');
  if (erase) {
    r.text('E', 207, y, litErase ? 'm' : 'b');
    r.text('ERASE', 219, y, litErase ? 'm' : 'i');
  }
  if (!touchOn) r.text(g.erasing ? 'ENTER ERASE  Q BACK' : 'ENTER PLAY', VIEW_W / 2, 124, 'p', { align: 'center' });
}

/** CONTINUE SLOT n? and ERASE SLOT n?, in the slot list's panel: the record's serial, level, TOMB n and coins. */
function drawSlotConfirm(g) {
  const r = g.renderer, { kind, n, held } = g.confirm;
  const { save, level, high, wallet, continues } = held.record;
  r.panel(62, 54, 196, 84);
  if (kind === 'erase') r.text(`ERASE SLOT ${n}?`, VIEW_W / 2, 62, 'o', { align: 'center' });
  else r.text(`CONTINUE SLOT ${n}?`, VIEW_W / 2, 62, 'i', { align: 'center' });
  r.text(save, 72, 78, 'c');
  r.text(`${difficultyLabel(level)}  TOMB ${high}`, 72, 90, 'b');
  r.text(kind === 'erase' ? `COINS  ${wallet}` : `COINS  ${wallet}  CONTINUES  ${continues}`, 72, 102, 'b');
  r.text('Y YES  N NO', 72, 118, 'p');
}

/**
 * NEW RUN: the header, naming the slot it binds; the seed with BEST TOMB n at
 * its right when a best is stored; the difficulty row; R NEW SEED and T TYPE A
 * CODE; or the code field while typing.
 */
function drawNewRun(g, t) {
  titleScene(g, t);
  const r = g.renderer, touchOn = touch && touch.on, best = titleBest(g);
  r.panel(62, 54, 196, touchOn && g.typing === null ? 74 : 88);
  r.text(g.bind === null ? 'NEW RUN' : `NEW RUN  SLOT ${g.bind}`, VIEW_W / 2, 62, 'i', { align: 'center' });
  if (g.typing !== null) {
    // No label, so TYPED_MAX characters and the cursor fit the panel.
    r.text(`${g.typing}${Math.floor(t * 2) % 2 ? '_' : ' '}`, 72, 76, 'c');
    r.text('ENTER  ACCEPT', 72, 90, 'b');
    r.text('ESC    CANCEL', 72, 102, 'b');
    r.text('SEED  XXXX-XXXX', 72, 116, '9');
    r.text('SAVE  XXXX-XXXX:P', 72, 128, '9');
  } else {
    r.text('SEED', 72, 76, 'b');
    r.text(formatCode(g.code), 108, 76, 'c');
    if (best !== null) r.text(`BEST TOMB ${best}`, 248, 76, 'p', { align: 'right' });
    drawSettingRow(g, 88);
    r.text('R', 72, 100, 'b');
    r.text('NEW SEED', 99, 100, 'b');
    r.text('T', 72, 112, 'b');
    r.text('TYPE A CODE', 99, 112, 'b');
    if (!touchOn) r.text('ENTER BEGIN  Q BACK', VIEW_W / 2, 126, 'p', { align: 'center' });
  }
  if (g.note) r.text(g.note, VIEW_W / 2, 152, 'o', { align: 'center' });
  r.text(touchOn ? 'D-PAD MOVE  RED BUTTON JUMP' : 'ARROWS/WASD MOVE  SPACE/Z JUMP  M MUTE  P PAUSE', VIEW_W / 2, 166, '9', { align: 'center' });
}

/**
 * NEW RUN's setting row at y: all four names after L, the current one lit.
 * The row spans 149 px and ends at 248, the panel's text margin.
 */
function drawSettingRow(g, y) {
  const r = g.renderer;
  r.text('L', 72, y, 'b');
  let x = 99;
  for (const d of DIFFICULTIES) {
    const name = difficultyLabel(d);
    r.text(name, x, y, d === g.difficulty ? 'p' : '7');
    x += (name.length + 1) * 6;
  }
}

/** SAVE IN? over the held run, rows 14 px apart from y 72, or the OVERWRITE SLOT n? it asks. */
function drawSaveIn(g) {
  const r = g.renderer, touchOn = touch && touch.on, si = g.saveIn;
  if (g.confirm) {
    const { n, held } = g.confirm;
    r.panel(62, 60, 196, touchOn ? 40 : 54);
    r.text(`OVERWRITE SLOT ${n}?`, VIEW_W / 2, 68, 'o', { align: 'center' });
    slotRow(g, held, n, 84, false, false);
    if (!touchOn) r.text('Y YES  N NO', VIEW_W / 2, 100, 'p', { align: 'center' });
    return;
  }
  r.panel(62, 50, 196, touchOn ? 66 : 80);
  r.text('SAVE IN?', VIEW_W / 2, 58, 'i', { align: 'center' });
  for (let i = 0; i < si.rows.length; i++) slotRow(g, si.rows[i].held, si.rows[i].n, 72 + 14 * i, i === si.cursor);
  if (!touchOn) r.text('ENTER SAVE  Q BACK', VIEW_W / 2, 116, 'p', { align: 'center' });
}

// The largest frame over the levels, ULTIMATE's 72x28 cells, spans the pause
// panel inside its 2 px rules, from y 28 under the PAUSED title; smaller maps
// centre in that frame.
const PAUSE_MAP_LEFT = PANEL_X.pause[0] + 2;
const PAUSE_MAP_TOP = 28;
const MAP_FRAME = Object.values(DIFFICULTY).map(mapCells)
  .reduce((m, c) => ({ cols: Math.max(m.cols, c.cols), rows: Math.max(m.rows, c.rows) }));

/** Top left of the pause map and its rows, for the world's tomb size. */
function mapOrigin(world) {
  const { cols, rows } = mapCells(world.size);
  return {
    x: PAUSE_MAP_LEFT + ((MAP_FRAME.cols - cols) * MAP_SCALE) / 2,
    y: PAUSE_MAP_TOP + Math.floor(((MAP_FRAME.rows - rows) * MAP_SCALE) / 2),
    rows,
  };
}

/** The pause map's model for the frame, rebuilt when the frame changes. */
function pauseModel(g) {
  if (!g.pauseMap || !sameFrame(g.pauseMap.frame, g.frame)) {
    const at = { bd: g.sim.bd, cell: g.sim.cell };
    g.pauseMap = { frame: g.frame, model: mapModel(g.world, g.sim.trail, g.frame, at) };
  }
  return g.pauseMap.model;
}

// The panel spans y 2..177; its rules leave y 5..174 for rows at least 4 px
// apart. An unsaved run's pause reads UNSAVED where SAVE CODE stands, and
// Enter there saves.
function drawPause(g, t = 0) {
  const r = g.renderer;
  r.panel(50, 2, 220, 176);
  r.text('PAUSED', VIEW_W / 2, 9, 'm', { align: 'center', scale: 2 });
  r.text(`CONTINUES ${g.sim.continues}`, 53, 16, 'a');
  r.text(`TOMB ${tombCount(g.sim)}`, 267, 16, 'a', { align: 'right' });
  if (g.pausedAt === null) g.pausedAt = t;
  const o = mapOrigin(g.world);
  r.drawMap(pauseModel(g), o.x, o.y, t - g.pausedAt);
  const here = `${hereCode(g)}  ${difficultyLabel(g.world.difficulty)}`;
  if (g.saveId === null) {
    r.text(g.copied ? `UNSAVED  ${g.copied}` : 'UNSAVED', VIEW_W / 2, 118, 'o', { align: 'center' });
    r.text(here, VIEW_W / 2, 129, 'i', { align: 'center' });
    if (touch && touch.on) return;
    r.text('ENTER SAVE  P RESUME  Q TITLE', VIEW_W / 2, 145, 'b', { align: 'center' });
    r.text('C COPY  M MUTE  ARROWS PAN', VIEW_W / 2, 156, 'b', { align: 'center' });
    return;
  }
  r.text(saveLabel(g.copied), VIEW_W / 2, 118, 'a', { align: 'center' });
  r.text(here, VIEW_W / 2, 129, 'i', { align: 'center' });
  r.text(g.audio.muted ? 'SOUND OFF' : 'SOUND ON', VIEW_W / 2, 141, '9', { align: 'center' });
  r.text('P RESUME  ARROWS PAN  Q TITLE', VIEW_W / 2, 153, 'b', { align: 'center' });
  r.text('M MUTE  C COPY', VIEW_W / 2, 164, 'b', { align: 'center' });
}

function drawOver(g) {
  const r = g.renderer, s = g.sim;
  r.panel(40, 34, 240, 124);
  r.text('THE TORCH IS OUT', VIEW_W / 2, 44, 'o', { align: 'center', scale: 2 });
  r.text(`TOMBS CLIMBED  ${tombCount(s)}`, VIEW_W / 2, 68, 'c', { align: 'center' });
  r.text(`TIME  ${clock(s.time)}`, VIEW_W / 2, 80, 'c', { align: 'center' });
  r.text(`COINS  ${g.earned}`, VIEW_W / 2, 92, 'c', { align: 'center' });
  r.text(`CONTINUES  ${s.continues}`, VIEW_W / 2, 103, 'c', { align: 'center' });
  r.text(saveLabel(g.copied), VIEW_W / 2, 118, 'a', { align: 'center' });
  r.text(`${entryCode(g)}  ${difficultyLabel(g.world.difficulty)}`, VIEW_W / 2, 130, 'i', { align: 'center' });
  r.text('ENTER CONTINUE  Q TITLE  C COPY', VIEW_W / 2, 146, 'b', { align: 'center' });
}

// The panel spans y 40..135; its rules leave y 43..132 for rows at least 4 px apart.
function drawSplash(g) {
  const r = g.renderer, { k, paid } = g.splash;
  const [x0, x1] = PANEL_X.splash;
  const name = rankName(k);
  r.panel(50, 40, 220, 96);
  r.text(`${k * MILESTONE} TOMBS`, VIEW_W / 2, 52, 'a', { align: 'center' });
  const scale = textWidth(name) * 2 <= x1 - x0 - 16 ? 2 : 1;
  r.text(name, VIEW_W / 2, 68, 'm', { align: 'center', scale });
  if (paid) r.text(`${k * MILESTONE} COINS`, VIEW_W / 2, 92, 'p', { align: 'center' });
  r.text('ENTER CONTINUE  Q HOME', VIEW_W / 2, 112, 'b', { align: 'center' });
}

function draw(g, t) {
  if (g.screen === 'title') drawTitle(g, t);
  else if (g.screen === 'newrun') drawNewRun(g, t);
  else {
    g.renderer.scene(g.sim, g.cam, t);
    g.renderer.hud(g.sim, g.wallet);
    if (g.screen === 'pause') drawPause(g, t);
    else if (g.screen === 'over') drawOver(g);
    else if (g.screen === 'splash') drawSplash(g);
    else if (g.screen === 'savein') drawSaveIn(g);
  }
  if (guard.shown()) paintError(g);
  present(g.renderer);
  if (touch) touch.refresh();
}

// The standard-mapped gamepads, read through navigator at poll time.
const gamepad = createGamepad(() => navigator.getGamepads());

/** Sends the key events the gamepads have due, as the keyboard would. */
function pollGamepads() {
  for (const o of gamepad.poll()) {
    window.dispatchEvent(new KeyboardEvent(o.type, { code: o.code, key: o.key, repeat: false, bubbles: true, cancelable: true }));
  }
}

// The frame guard `runLoop` sets; null before it runs.
let guard = null;

// A dark strip across the middle of the view, whatever the frame drew.
const ERROR_STRIP = { y: 78, h: 24 };

/** Paints the ERROR line over the frame in the view. */
function paintError(g) {
  const r = g.renderer;
  r.ctx.fillStyle = shade(1);
  r.ctx.fillRect(0, ERROR_STRIP.y, VIEW_W, ERROR_STRIP.h);
  r.text(errorLine(g.point && g.point.save, formatCode(g.code)), VIEW_W / 2, ERROR_STRIP.y + 8, 'o', { align: 'center' });
}

/** Fixed 60 Hz ticks, rendering once per animation frame. */
function runLoop(g) {
  guard = createGuard({
    request: (next) => requestAnimationFrame(next),
    screen: () => g.screen,
    step: TICK,
    start: performance.now(),
    // The self-test fails on the first frame exception, as an uncaught one did.
    log: (e) => { console.error(e); if (SELFTEST) reportError(e); },
    // `run` calls this outside its try, so a throw here escapes on every frame.
    onFail: () => {
      paintError(g);
      // A failure outside the composite leaves a clean frame to draw over.
      try { g.renderer.composite(); } catch { /* the guard logged the frame's failure */ }
      drawOverlay();
    },
  });
  window.addEventListener('keydown', (e) => { if (!e.repeat) guard.release(); });
  function frame(now) {
    guard.run(frame, now, (due) => {
      pollGamepads();
      while (due()) tick(g);
      draw(g, now / 1000);
    });
  }
  draw(g, 0);
  requestAnimationFrame(frame);
}

function boot() {
  const g = newGame();
  // A layout change moves the title's explorer with it.
  const refit = () => {
    fit();
    if ((g.screen === 'title' || g.screen === 'newrun') && g.preview) titleCam(g);
  };
  // `touch.refresh` reads this every frame; in play it reads no storage.
  touch = createTouch({
    state: () => ({
      screen: g.screen, typing: g.typing !== null, confirm: g.confirm !== null, muted: g.audio.muted, difficulty: g.difficulty, side: g.side,
      resume: g.screen === 'title' && g.open !== null, erasing: g.erasing, erase: g.screen === 'title' && eraseShows(),
      unsaved: g.screen === 'pause' && g.saveId === null,
      rows: g.screen === 'savein' ? g.saveIn.order : g.screen === 'title' && g.erasing ? usedRows() : '',
    }),
    onMode: refit,
  });
  window.addEventListener('keydown', (e) => onKeyDown(g, e));
  window.addEventListener('keyup', (e) => {
    const k = DIRS[e.code];
    if (!k) return;
    g.keys.delete(k);
    if (g.screen === 'play') g.release |= DIR_BITS[k];
  });
  window.addEventListener('blur', () => g.keys.clear());
  // A tap grants activation on pointerup and click; pointerdown grants none.
  window.addEventListener('pointerup', () => g.audio.start());
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  fit();
  useCode(g, g.code);
  runLoop(g);
  return g;
}

if (SELFTEST) selftest();
else boot();
