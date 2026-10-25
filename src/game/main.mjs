// Boot, input, the fixed 60 Hz loop and the title, LOAD, the overwrite pick,
// play, pause and its SAVE IN?, end and milestone splash screens. `#selftest`
// in the URL runs the self-test instead.
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
  SAVE_SLOTS, MIGRATED_KEY, saveKey, parseSave, serializeSave, risePay, commitSave, takeSave, migrateSaves,
  playedLabel, playedSlot,
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
// The self-test's switch for storage that refuses writes, as full storage does:
// reads still answer, and a free key still reads absent.
let refuseWrites = false;

const memoryArea = memory && {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    if (refuseWrites) throw new Error('storage refuses writes');
    memory.set(key, String(value));
  },
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

// Each save key as last parsed, keyed by the raw text it came from: LOAD and
// the pick read all three every frame.
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

/** The lowest-numbered free slot, read now, or undefined with none. */
const freeSlot = () => SAVE_SLOTS.find((k) => isFree(heldSave(k)));

/** True while every slot reads NEWER. */
const allNewer = () => SAVE_SLOTS.every((k) => heldSave(k).state === 'newer');

/**
 * True while a slot can take a write: the latest store landed and one slot at
 * least reads other than NEWER. With none writable a run plays unsaved and no
 * slot question asks.
 */
const writable = () => !storage.failed() && !allNewer();

// What a slot row reads when it holds no record this build can play.
const ROW_LABEL = { absent: 'EMPTY', damaged: 'DAMAGED', newer: 'NEWER' };

const slotIo = { load, store, remove: unstore };

/** Where the record pairs sim save point `at`, { p, net }: the serial of its board, the net there and the run's start tomb. */
function pointOf(g, at) {
  const { x, y } = boardOfPos(at.p), { u, v } = g.sim.start;
  return { save: encodeSave(g.code, x, y), net: at.net, start: `${u},${v}` };
}

/**
 * The run's record at `point`, played now. A dead run writes the count any
 * continuation of it carries: its own plus one. Every record carries the takes
 * of the run's recent tombs.
 */
function runState(g, point) {
  const { high, continues, state } = g.sim;
  return {
    id: g.saveId, save: point.save, level: g.world.difficulty, start: point.start, net: point.net, high,
    wallet: g.wallet, continues: state === 'over' ? continues + 1 : continues, recent: packRecent(g.world, g.sim),
    played: Date.now(),
  };
}

// The note's two seconds, in ticks of play.
const NOTE_TICKS = 120;
const NOT_SAVED = 'NOT SAVED: PAUSE TO SAVE';

/** Shows `text` in play for NOTE_TICKS ticks, in ink `ink`, replacing any note. */
function setNote(g, text, ink) {
  Object.assign(g, { noteText: text, noteInk: ink, noteTicks: NOTE_TICKS });
}

/** The run holds no slot. Its next write takes none by itself: a caller applies the free-slot rule. */
function unbind(g) {
  Object.assign(g, { slot: null, saveId: null, point: null, mark: null, armed: false });
}

/** An unsaved run's pay, in memory: the tick's `coins` and the rise of the high over `was`. */
function payInMemory(g, coins, was) {
  const earned = coins + risePay(g.world.difficulty, was, tombCount(g.sim));
  g.wallet += earned;
  return { earned, seen: was };
}

/** The run adopts write `out` at `point`: its id, wallet, the merged high and, while live, the merged continue count. */
function adopt(g, out, point) {
  g.saveId = out.record.id;
  g.point = point;
  g.wallet = out.record.wallet;
  g.sim.high = out.record.high;
  if (g.sim.state !== 'over') g.sim.continues = out.record.continues;
}

/**
 * Takes slot n for the run at `point` under a fresh id, paying the tick's
 * `coins` and the rise of the high over `was`: a free slot, or with `over` the
 * valid record under that id. A take that finds anything else, or whose store
 * does not land, binds nothing. Returns the take's result.
 */
function take(g, n, point, { coins = 0, was = tombCount(g.sim), over = null } = {}) {
  const out = takeSave(slotIo, saveKey(n), { ...runState(g, point), id: newSlotId() }, { coins, paid: was, over });
  if (out.ok) {
    Object.assign(g, { slot: n, mark: null, armed: false });
    adopt(g, out, point);
  }
  return out;
}

/**
 * The free-slot rule at `point`: re-reads the slots and takes the lowest free
 * one, noting SAVED IN SLOT n. With all three full the run plays on unsaved,
 * noting NOT SAVED: PAUSE TO SAVE, and writes nothing more by itself. With no
 * slot writable, and after a take whose store did not land, it binds nothing
 * and notes nothing. Returns the pay.
 */
function takeFree(g, point, { coins = 0, was = tombCount(g.sim) } = {}) {
  if (!writable()) return payInMemory(g, coins, was);
  const n = freeSlot();
  if (n === undefined) {
    g.armed = false;
    setNote(g, NOT_SAVED, 'o');
    return payInMemory(g, coins, was);
  }
  const out = take(g, n, point, { coins, was });
  if (!out.ok) return payInMemory(g, coins, was);
  setNote(g, `SAVED IN SLOT ${n}`, 'm');
  return out;
}

/**
 * The marked run's first write at `point`: it re-reads its slot, and the
 * record the confirm drew means overwrite; anything else falls back to the
 * free-slot rule. With no slot writable it binds nothing and keeps the mark.
 */
function markWrite(g, point, pay) {
  if (!writable()) return payInMemory(g, pay.coins, pay.was);
  const { n, id } = g.mark, held = heldSave(n);
  if (held.state !== 'valid' || held.record.id !== id) {
    g.mark = null;
    return takeFree(g, point, pay);
  }
  const out = take(g, n, point, { ...pay, over: id });
  if (!out.ok) return payInMemory(g, pay.coins, pay.was);
  setNote(g, `SAVED IN SLOT ${n}`, 'm');
  return out;
}

/**
 * Writes the bound run's record at `point` to its slot, paying the tick's
 * `coins` and the rise of the high over `was`, and returns the write's result
 * with the pay's `earned` and `seen`. A slot holding another save, none or a
 * newer build's is taken under the run: the run unbinds and the free-slot rule
 * applies at once, at the same point. A live run adopts the merged continue
 * count; a dead run keeps its own, so every write on one death stores one rise.
 */
function commit(g, point, { coins = 0, was = tombCount(g.sim) } = {}) {
  const out = commitSave(slotIo, saveKey(g.slot), runState(g, point), { coins, paid: was });
  if (!out.ok) {
    unbind(g);
    return takeFree(g, point, { coins, was });
  }
  adopt(g, out, point);
  return out;
}

/**
 * The one writer that moves a bound run's serial. Save point `at` is one value
 * holding a board and the net there, so no write pairs a serial with another
 * moment's net. A run holding no slot writes nothing here.
 */
function writeAt(g, at, pay = {}) {
  if (g.saveId === null) return null;
  return commit(g, pointOf(g, at), pay);
}

/**
 * An unbound run's coin or counted tomb at `point`: a marked run writes its
 * mark, a run with the free-slot rule armed takes the lowest free slot, and
 * any other pays in memory.
 */
function claim(g, point, { coins, was }) {
  if (g.mark) return markWrite(g, point, { coins, was });
  if (g.armed) return takeFree(g, point, { coins, was });
  return payInMemory(g, coins, was);
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
  need(touch.soft('title', 'begin').getBoundingClientRect().width === 0, 'controls hidden in keyboard mode');
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
  // LOAD from the title, whatever screen the last step left.
  const toLoad = () => { toTitle(g); draw(g, 0); click('title', 'load'); };

  // Mode switch and canvas size.
  pointer('pointerdown', display, 10, 10);
  need(touch.on, 'a touch pointerdown turns touch mode on');
  live(touch.soft('title', 'begin'), 'title/begin');
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

  // Title: its cursor lights BEGIN, and K copies the shown seed.
  need(g.screen === 'title' && g.cursor === BEGIN_ROW, 'the title\'s cursor lights ENTER BEGIN');
  const rolled = g.code;
  click('title', 'reset');
  need(g.code !== rolled, 'RESET changes the code');
  toggles('title');
  const sound = touch.soft('title', 'sound'), soundArt = sound.querySelector('canvas'), muted = g.audio.muted;
  need(!touchTap(display, 1000, 1100), 'a lone tap on the view is left to the browser');
  need(touchTap(display, 1400, 1900), 'a tap starting 300 ms after a lift is cancelled, however long it is held');
  need(!touchTap(soundArt, 3000, 3100) && g.audio.muted === muted, 'a lone tap on a key is left to the browser');
  need(touchTap(soundArt, 3400, 3500) && g.audio.muted !== muted, 'a quick second tap on a key is cancelled and clicks it');
  need(touchTap(soundArt, 3800, 3900, display) && g.audio.muted !== muted, 'a quick second tap lifted off its key clicks nothing');
  click('title', 'sound');
  copies('title', formatCode(g.code));
  // LOAD's TYPE CODE takes a pasted seed, which returns to the title.
  withPrompt('K7Q2-M9XA', () => {
    toLoad();
    click('load', 'type');
    need(g.code === 'K7Q2M9XA' && g.typing === null, 'TYPE CODE takes the answer');
  });
  withPrompt(null, () => {
    toLoad();
    click('load', 'type');
    need(g.code === 'K7Q2M9XA' && g.typing === null, 'TYPE CODE cancel keeps the code and closes typing');
  });

  // Typing.
  toLoad();
  press('KeyT', 't');
  draw(g, 0);
  need(g.typing !== null, 'KeyT opens typing');
  press('KeyP', 'p');
  need(g.screen === 'load' && g.typing === 'P', 'P types a letter in the code field');
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
  toTitle(g);
  draw(g, 0);
  click('title', 'begin');
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
  copies('pause', hereCode(g));
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

  // Resume the open run: the title's keys change only its preview.
  click('title', 'difficulty');
  need(g.world !== runWorld && g.difficulty !== runWorld.difficulty, 'the difficulty key rebuilds the preview');
  click('title', 'reset');
  need(g.code !== runCode, 'RESET changes the preview\'s seed');
  click('title', 'pad');
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
  for (const leg of LEGS) leg(g, { need, click, press, offEntry, fake });

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

/** The touch leg's difficulty steps, from the title with no run open. */
function difficultyLeg(g, { need, click, press, offEntry }) {
  const sized = (d) => g.difficulty === d && g.world.difficulty === d && load(KEY_DIFFICULTY) === d
    && g.world.size.w === DIFFICULTY[d].w && g.world.size.h === DIFFICULTY[d].h;

  // The title's key cycles the four levels, and the preview's tomb size follows.
  openTitle(g);
  setDifficulty(g, 'easy');
  draw(g, 0);
  need(sized('easy'), 'the setting starts at EASY');
  for (const d of ['medium', 'hard', 'ultimate', 'easy']) {
    click('title', 'difficulty');
    need(sized(d), `the difficulty key moves to ${difficultyLabel(d)}`);
  }
  // The arrows step it and stop at the ends.
  for (const [code, d] of [['ArrowRight', 'medium'], ['ArrowRight', 'hard'], ['ArrowRight', 'ultimate'], ['ArrowRight', 'ultimate'],
    ['ArrowLeft', 'hard'], ['ArrowLeft', 'medium'], ['ArrowLeft', 'easy'], ['ArrowLeft', 'easy']]) {
    press(code, code);
    need(sized(d), `${code} steps the setting to ${difficultyLabel(d)}`);
  }
  // A held H repeats; the title ignores the repeat, so the pad keeps its side.
  const side = g.side;
  press('KeyH', 'h', true);
  need(g.side === side && load(KEY_PAD) === side, 'the title ignores an auto-repeated H');

  // A save loads at the difficulty that wrote it. Each run takes slot 1, free, at its first coin, and its
  // PAUSE and TITLE leave it open on the title.
  const saveAt = (d) => {
    clearSaves();
    openTitle(g);
    setDifficulty(g, d);
    softTap(g, click, 'title', 'begin');
    offEntry();
    earnFake(g);
    click('play', 'pause');
    need(saveNow(1).level === d, `PAUSE stores ${difficultyLabel(d)} with the save`);
    const where = { x: g.sim.bd.x, y: g.sim.bd.y, sim: g.sim };
    click('pause', 'title');
    return where;
  };
  // With no run open, LOAD's cursor starts on the save's row, and Enter loads it.
  const loadsAt = (d, where) => {
    g.open = null;
    press('KeyT', 't');
    press('Enter', 'Enter');
    need(g.screen === 'play' && sized(d), `LOAD rebuilds the save at ${difficultyLabel(d)} and moves the setting`);
    need(g.sim !== where.sim && g.sim.bd.x === where.x && g.sim.bd.y === where.y, `the ${difficultyLabel(d)} save resumes on its board`);
  };
  const stepSetting = (code, times) => {
    for (let i = 0; i < times; i++) press(code, code);
  };
  // A HARD save loads at HARD, the 4x4 world.
  const hard = saveAt('hard');
  stepSetting('ArrowLeft', 2);
  need(sized('easy'), 'the setting moves to EASY over a HARD save');
  loadsAt('hard', hard);
  need(g.world.size.w === 4 && g.world.size.h === 4, 'a HARD save resumes in a 4x4 world');
  softTap(g, click, 'play', 'pause');
  click('pause', 'title');
  const old = saveAt('ultimate');
  // A held P or Esc repeats; the title ignores the repeat, so the open run stays open.
  press('KeyP', 'p', true);
  need(g.screen === 'title' && g.open !== null, 'the title ignores an auto-repeated P');
  press('Escape', 'Escape', true);
  need(g.screen === 'title' && g.open !== null, 'the title ignores an auto-repeated Esc');
  stepSetting('ArrowLeft', 3);
  need(sized('easy'), 'the setting moves to EASY over an ULTIMATE save');
  loadsAt('ultimate', old);
  need(g.world.size.w === 6 && g.world.size.h === 4, 'LOAD plays the ULTIMATE save on its board');
  softTap(g, click, 'play', 'pause');
  click('pause', 'title');
  const easy = saveAt('easy');
  stepSetting('ArrowRight', 1);
  need(sized('medium'), 'the setting moves to MEDIUM over an EASY save');
  loadsAt('easy', easy);

  // RESET rolls a new seed and keeps the slot.
  softTap(g, click, 'play', 'pause');
  click('pause', 'title');
  const kept = load(saveKey(1)), code = g.code;
  click('title', 'reset');
  need(g.code !== code && kept !== null && load(saveKey(1)) === kept, 'RESET changes the seed and keeps the slot');

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

/** A record of the self-test's MEDIUM seed with nothing earned, as revision 1's beta wrote it, with no `played`; `putSave` fills in what a step changes. */
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

/** A clean run over three empty slots, the free-slot rule armed: its first coin or counted tomb takes slot 1. */
function armSlot(g) {
  clearSaves();
  cleanState(g);
  g.armed = true;
}

/** Sends game `h` a keydown, as the window would a key; `h` is a game made by `reload`, with no listener of its own. */
function keyTo(h, code, key, repeat = false) {
  onKeyDown(h, new KeyboardEvent('keydown', { code, key, repeat, bubbles: true, cancelable: true }));
}

/** Game `h` loads slot n from LOAD, by T and the slot's digit. */
function loadSlot(h, n) {
  keyTo(h, 'KeyT', 't');
  keyTo(h, `Digit${n}`, String(n));
}

/** Draws a frame, so the touch layer places its keys, then clicks soft key `id` of screen `sid`. */
function softTap(g, click, sid, id) {
  draw(g, 0);
  click(sid, id);
}

/** The title with no run open, as at startup. The economy stays as it is. */
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

/** The oil steps of the touch leg, from the title with no run open. Each run takes slot 1 at its first coin. */
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
    softTap(g, click, 'title', 'begin');
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
 * The gamepad steps of the touch leg, from the title with no run open. Each
 * button change polls the fake gamepad, as the frame loop does.
 */
function gamepadLeg(g, { need, click, fake }) {
  const hold = (...buttons) => {
    fake.held = new Set(buttons);
    pollGamepads();
  };
  const A = 0, B = 1, SELECT = 8, START = 9, LEFT = 14;
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  openTitle(g);
  click('title', 'begin');
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
  cleanState(g);
}

/** Walks game `h` toward `home` until its feet lie more than 12 px from `spot`, so a walk to the spot runs ticks. */
function walkAway(h, home, spot) {
  const auto = createAutopilot(h.world, [home]);
  const far = () => { const [fx, fy] = feet(h.sim); return Math.abs(fx - spot[0]) > 12 || Math.abs(fy - spot[1]) > 12; };
  runTicks(h, auto, far, 600, 'the walk leaves the coin');
}

/** The coin steps of the touch leg, from the title with no run open. */
function coinLeg(g, { need, click, press }) {
  const rates = { easy: 1, medium: 2, hard: 5, ultimate: 10 };
  const onLevel = (d) => {
    setDifficulty(g, d);
    useCode(g, SELFTEST_CODE);
  };

  // Step 1: the first coin of tomb (0, 0) at MEDIUM takes slot 1, the lowest free.
  cleanState(g);
  clearSaves();
  onLevel('medium');
  openTitle(g);
  click('title', 'begin');
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
  loadSlot(later, 1);
  need(later.screen === 'play' && takes(later) === 0, 'LOAD after a reload keeps the coin taken');
  openTitle(g);
  click('title', 'begin');
  need(g.screen === 'play' && takes(g) === 1, 'BEGIN lays the coin back');

  // Step 3: each level over empty slots. A rise of the high pays the level's rate, and a replay of the
  // tomb pays nothing, since the save's high already holds it. Each wallet check nets out the floor coins
  // the walk took, which lie back with every new run.
  for (const d of DIFFICULTIES) {
    const label = difficultyLabel(d);
    armSlot(g);
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
  click('title', 'begin');
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

  // Step 5: the coins and jars of the last two tombs, over empty slots at MEDIUM. A is tomb (0, 0), B the
  // tomb its exit leads to and C the tomb B's exit leads to. A pinned walk holds the burn at 100 s before
  // every tick, so its contact tick shows whether the jar added its 60 s; a long walk starts with the torch
  // full.
  clearSaves();
  onLevel('medium');
  openTitle(g);
  click('title', 'begin');
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
    loadSlot(h, 1);
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

/** The two-games step of the touch leg, from the title with no run open. */
function twoGamesLeg(g, { need }) {
  // Two games that loaded one save share its id. A second game, made before the first one's write,
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
 * Each run takes slot 1, free, at its first counted tomb.
 */
function splashLeg(g, { need, click, press }) {

  // Step 1: the first crossing of tomb 100 shows TORCHBEARER and pays the rate plus 100, at every level.
  for (const d of DIFFICULTIES) {
    armSlot(g);
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
  armSlot(g);
  const before = g.wallet;
  const ended = oneTombOn(g, 99, ticks);
  need(g.screen === 'over' && tombCount(g.sim) === 100, 'a run that ends on the crossing of tomb 100 shows the end screen');
  need(g.wallet - before - ended.coins === COIN_RATE[level] + 100, 'the payout stands when the run ends on the crossing of tomb 100');
  draw(g, 0);
}

/**
 * The load steps of the touch leg, from the title with no run open. Each
 * `reload` is a fresh game over the same storage, as after a page reload.
 */
function resumeLeg(g, { need, click }) {
  const level = 'medium';
  setDifficulty(g, level);
  useCode(g, SELFTEST_CODE);
  clearSaves();
  openTitle(g);
  click('title', 'begin');
  oneTombOn(g, 1);
  const count = tombCount(g.sim);
  draw(g, 0);
  click('play', 'pause');
  const saved = saveNow(1).save;

  // The count survives a reload through the slot.
  const resumed = reload();
  loadSlot(resumed, 1);
  need(count >= 2 && resumed.screen === 'play' && tombCount(resumed.sim) === count, `LOAD after a reload continues at TOMB ${count}`);
  need(resumed.sim.start.u === 0 && resumed.sim.start.v === 0 && resumed.earned === 0, 'a resumed run keeps its start tomb and earns afresh');

  // A typed copy of the slot's serial continues it.
  const typed = reload();
  typed.typing = saved;
  submitTyped(typed);
  need(tombCount(typed.sim) === count, `a typed copy of the slot's serial continues at TOMB ${count}`);

  // A save at net 99 under a high of 100 crosses back up to its high: TOMB 100 holds, nothing pays and no
  // splash shows.
  const exit = exitBoard(g.world), at = encodeSave(SELFTEST_CODE, exit.x, exit.y);
  putSave(1, { save: at, net: 99, high: 100 });
  const late = reload();
  loadSlot(late, 1);
  need(tombCount(late.sim) === 100 && late.sim.net === 99, 'LOAD after a reload continues at TOMB 100 from net 99');
  const was = late.wallet;
  const chain = late.world.tombFlames(0, 0).chains[0], auto = createAutopilot(late.world, [chain[chain.length - 1]]);
  let coins = 0;
  runTicks(late, auto, () => late.sim.net >= 100, 4000, 'the walk out of tomb (0, 0) reaches net 100',
    () => { for (const ev of late.sim.events) if (ev === 'coin') coins++; });
  need(late.screen === 'play' && tombCount(late.sim) === 100 && late.wallet - was === coins && saveNow(1).high === 100,
    'a resumed run crossing back up to its high pays nothing and shows no splash');
}

/**
 * Loads and a new run's clean start, from the title with no run open: LOAD's
 * SLOT 1 key and a typed serial load slot 1's record, and BEGIN and any other
 * typed code start clean.
 */
function continueLeg(g, { need, click, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const coin = firstCoin(g.world), first = g.world.startPoint().board;
  const serial = encodeSave(SELFTEST_CODE, first.x, first.y);
  // Slot 1 holds 300 coins and TOMB 20 at tomb (0, 0)'s first board; slots 2 and 3 are empty.
  const toStart = () => {
    clearSaves();
    putSave(1, { save: serial, net: 20, high: 20, wallet: 300 });
    cleanState(g);
    openTitle(g);
  };
  const pasteCode = (text) => {
    press('KeyT', 't');
    withPrompt(text, () => softTap(g, click, 'load', 'type'));
  };
  const tap = (sid, which) => softTap(g, click, sid, which);
  // The title after a played, loaded run: wallet 300 under save AAAAAAAA, not clean.
  const played = () => {
    toStart();
    press('KeyT', 't');
    tap('load', 's1');
    endRun(g);
    tap('over', 'title');
    need(g.screen === 'title' && g.saveId === SAVE_BASE.id && g.wallet === 300, 'a played run leaves the title with its wallet');
  };
  const restored = () => g.screen === 'play' && g.slot === 1 && g.saveId === SAVE_BASE.id && g.wallet === 300 && tombCount(g.sim) === 20
    && g.sim.collected.size === 0;

  // A typed serial on another seed starts clean.
  toStart();
  pasteCode('K7Q2-M9XA:13');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'a new serial starts with no coins');

  // LOAD's SLOT 1 key loads the slot's wallet and TOMB 20, with every coin back on the floor.
  toStart();
  press('KeyT', 't');
  tap('load', 's1');
  need(restored(), 'a load restores the slot\'s wallet and TOMB 20');
  walkToItem(g, coin);
  need(g.wallet === 301 && g.earned === 1, 'a coin of the restored tomb lies back and pays one');
  endRun(g);
  draw(g, 0);
  click('over', 'continue');
  need(g.screen === 'play' && g.saveId === SAVE_BASE.id && g.wallet === 301 && saveNow(1).id === SAVE_BASE.id, 'Continue keeps the run\'s slot and coins');
  toStart();
  pasteCode(serial);
  need(restored(), 'a typed copy of the slot\'s serial loads it');

  // A typed serial and BEGIN start clean after a played run.
  played();
  pasteCode('K7Q2-M9XA:13');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'a typed serial other than the slot\'s starts clean');
  played();
  tap('title', 'begin');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'BEGIN after a restored run starts with no coins at TOMB 0');
}

/**
 * The migration steps of the touch leg, from the title with no run open. A
 * page reload migrates the old slot, or the seven legacy keys of a HARD save
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
  // A page reload migrates, and LOAD opens on the migrated save's row, slot 1.
  const ask = () => {
    const h = reload();
    keyTo(h, 'KeyT', 't');
    return h;
  };

  // The old slot, of TOMB 20 and a record of 50, migrates to slot 1 at net 20 and high 50 and stays as
  // stored, for older builds; emptying every slot then never brings it back.
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
  need(heldSave(1).state === 'absent' && load(OLD_SLOT_KEY) === old, 'emptying every slot never brings the old save back');

  // The legacy keys migrate once, with the device wallet, and go.
  oldKeys();
  let h = ask();
  need(h.screen === 'load' && h.row === 0 && saveNow(1) !== null, 'LOAD over a legacy save opens on its row');
  const slot = saveNow(1);
  need(slot.wallet === 57 && slot.net === 20 && slot.high === 20 && slot.level === level, 'a legacy save keeps its wallet, TOMB and difficulty');
  need(load(MIGRATED_KEY) === '1' && gone(), 'a legacy save adopts the device wallet once');
  keyTo(h, 'Enter', 'Enter');
  need(h.screen === 'play' && h.wallet === 57 && tombCount(h.sim) === 20 && h.difficulty === level, 'LOAD plays a legacy save at its wallet, TOMB and difficulty');

  // A save with no difficulty beside it plays at ULTIMATE, the 6x4 world, whatever the stacked world's save left.
  oldKeys({ difficulty: null });
  store(STACKED, 'easy');
  h = ask();
  need(saveNow(1).level === 'ultimate', 'a legacy save with no stored difficulty adopts at ULTIMATE');
  keyTo(h, 'Enter', 'Enter');
  need(h.screen === 'play' && h.difficulty === 'ultimate' && h.world.difficulty === 'ultimate', 'LOAD plays a legacy save with no stored difficulty at ULTIMATE');
  unstore(STACKED);

  // The run counts only when it names the save.
  // A save in tomb (1, 0) with no run starts there, as a typed save code does, so its tombs can count.
  const board = boardCoords(1, 0, 0, g.world.size), elsewhere = encodeSave(SELFTEST_CODE, board.x, board.y);
  oldKeys({ save: elsewhere, run: null });
  h = ask();
  need(saveNow(1).net === 0 && saveNow(1).start === '1,0', 'a legacy save without a run resumes at its own tomb');
  keyTo(h, 'Enter', 'Enter');
  need(h.screen === 'play' && h.sim.net === 0 && h.sim.start.u === 1 && h.sim.start.v === 0 && h.point.start === '1,0',
    'LOAD plays a legacy save without a run from its own tomb');
  oldKeys({ run: { save: encodeSave(SELFTEST_CODE, first.x + 1, first.y), start: '0,0', solved: twenty } });
  h = ask();
  need(saveNow(1).net === 0, 'a legacy run naming another save migrates at net 0');
  fresh();
}

// The matrix legs prove design §6, a leg a row. Each check's message opens
// with its cell, as `M1F`, so a mutation row names the cell it breaks.

// Slot n's valid record in a matrix leg: id `slotId(n)`, wallet 10n, played n
// hours after PLAYED, the serial SAVE_BASE's unless a leg sets it.
const HOUR = 3600000;
const PLAYED = Date.UTC(2026, 9, 25);
const slotId = (n) => `${'ABC'[n - 1]}AAAAAAA`;
// A newer build's record.
const NEWER_TEXT = JSON.stringify({ v: 2, id: 'NNNNNNNN', save: SAVE_BASE.save, level: 'medium', skins: ['gold'] });

/**
 * Fills the three slots by `spec`, a character a slot: '.' EMPTY, 'd'
 * DAMAGED, 'n' NEWER and 'v' slot n's valid record, whose fields `over[n]`
 * changes.
 */
function fill(spec, over = {}) {
  SAVE_SLOTS.forEach((n, i) => {
    if (spec[i] === '.') unstore(saveKey(n));
    else if (spec[i] === 'd') store(saveKey(n), '{not json');
    else if (spec[i] === 'n') store(saveKey(n), NEWER_TEXT);
    else putSave(n, { id: slotId(n), wallet: 10 * n, played: PLAYED + n * HOUR, ...over[n] });
  });
}

/** Storage refuses writes while `on`. A store of the pad's side makes `storage.failed()` follow at once. */
function refuse(on) {
  refuseWrites = on;
  store(KEY_PAD, padSide(load(KEY_PAD)));
}

/** The title with no run open over slots `spec` (fill), at MEDIUM on the self-test seed, the economy clean. */
function fresh(g, spec, over) {
  fill(spec, over);
  cleanState(g);
  setDifficulty(g, 'medium');
  if (g.code !== SELFTEST_CODE) useCode(g, SELFTEST_CODE);
  openTitle(g);
}

/** The serial of the self-test seed's start board at MEDIUM. */
function startSerial() {
  const { board } = createWorld(SELFTEST_CODE, { difficulty: 'medium' }).startPoint();
  return encodeSave(SELFTEST_CODE, board.x, board.y);
}

/** The serial of tomb (0, 0)'s exit board at MEDIUM: a maze board of the self-test seed apart from the start board. */
function exitSerial() {
  const X = exitBoard(createWorld(SELFTEST_CODE, { difficulty: 'medium' }));
  return encodeSave(SELFTEST_CODE, X.x, X.y);
}

/** Game `h` types `text` into LOAD's code entry, opening LOAD from the title, a key a character, then Enter. */
function typeIn(h, text) {
  if (h.screen === 'title') keyTo(h, 'KeyT', 't');
  keyTo(h, 'KeyT', 't');
  for (const ch of text) keyTo(h, /[0-9]/.test(ch) ? `Digit${ch}` : /[A-Z]/.test(ch) ? `Key${ch}` : ch === '-' ? 'Minus' : 'Semicolon', ch);
  keyTo(h, 'Enter', 'Enter');
}

/** Game `h` stands still for n ticks of its own tick. */
function stand(h, n) {
  for (let i = 0; i < n; i++) {
    h.keys.clear();
    Object.assign(h, { press: 0, release: 0, jump: false });
    tick(h);
  }
}

/** The torch of game `h`'s run dies through its own tick, whose endRun writes. */
function die(h) {
  h.sim.burn = 0;
  h.sim.ember = TICK / 2;
  runTicks(h, () => [0, 0, false], () => h.screen === 'over', 10, 'the torch dies');
}

/** True when the last frame drew the note: a pixel of the overlay's note line is set. */
function noteDrawn() {
  const px = view.getContext('2d').getImageData(80, NOTE_Y, 160, 8).data;
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return true;
  return false;
}

/** True when the last LOAD frame drew nothing on slot n's second line: its pixels match the panel's right of it. */
function timeBlank(n) {
  const y = ROWS_Y[n - 1] + 9, ctx = view.getContext('2d');
  const ref = ctx.getImageData(250, y, 1, 1).data, px = ctx.getImageData(84, y, 80, 7).data;
  for (let i = 0; i < px.length; i++) if (px[i] !== ref[i % 4]) return false;
  return true;
}

/** An open run on the title that holds no slot and 5 coins, as one the free-slot rule left unsaved; returns its sim. */
function openUnsaved(g) {
  cleanState(g);
  begin(g);
  g.wallet = 5;
  const run = g.sim;
  leaveOpen(g);
  draw(g, 0);
  return run;
}

/** M8, Enter or a digit on an EMPTY, DAMAGED or NEWER row of LOAD: nothing loads, starts or asks. */
function m8Leg(g, { need }) {
  // Enter and the digit on each of slots `rows`, LOAD's cursor walked from its first row down.
  const tries = (rows) => {
    const sim = g.sim, kept = savesText();
    keyTo(g, 'KeyT', 't');
    for (let i = 0; i < 3; i++) keyTo(g, 'ArrowUp', 'ArrowUp');
    for (const n of SAVE_SLOTS) {
      if (rows.includes(n)) {
        keyTo(g, 'Enter', 'Enter');
        keyTo(g, `Digit${n}`, String(n));
      }
      keyTo(g, 'ArrowDown', 'ArrowDown');
    }
    return g.screen === 'load' && g.confirm === null && g.typing === null && g.sim === sim && savesText() === kept;
  };
  fresh(g, '.dv');
  need(heldSave(2).state === 'damaged' && ROW_LABEL[heldSave(2).state] === 'DAMAGED', 'a slot holding an unparseable string reads DAMAGED, never EMPTY');
  need(tries([1, 2]), 'M8F Enter and the digits of an EMPTY and a DAMAGED row do nothing');
  fresh(g, 'vnv');
  need(heldSave(2).state === 'newer' && ROW_LABEL[heldSave(2).state] === 'NEWER', 'a slot holding a v 2 record reads NEWER');
  need(tries([2]), 'M8U Enter and the digit of a NEWER row do nothing');
  fresh(g, 'nnn');
  need(tries([1, 2, 3]), 'M8N Enter and the digits of three NEWER rows do nothing');
  fresh(g, '...');
  refuse(true);
  need(tries([1, 2, 3]), 'M8N with storage refusing writes Enter and the digits of EMPTY rows do nothing');
  refuse(false);
}

/** M19, two games BEGIN at once over one free slot: the first write takes it, and the other plays on as row 11. */
function m19Leg(g, { need }) {
  fresh(g, '.vv');
  keyTo(g, 'Enter', 'Enter');
  const other = reload();
  keyTo(other, 'Enter', 'Enter');
  need(g.screen === 'play' && other.screen === 'play' && g.armed && other.armed, 'M19F two games BEGIN at once over one free slot');
  earnFake(g);
  const won = load(saveKey(1));
  earnFake(other);
  need(g.slot === 1 && saveNow(1).id === g.saveId && load(saveKey(1)) === won && other.saveId === null && !other.armed,
    'M19F the first write takes the free slot, and the other game plays on unsaved');
}

/** M11, another game fills the free slot before this run's first write: the next free one takes it, or none does. */
function m11Leg(g, { need }) {
  // M11F: slots 1 and 2 free; the other game's first coin takes slot 1.
  fresh(g, '..v');
  keyTo(g, 'Enter', 'Enter');
  const other = reload();
  keyTo(other, 'Enter', 'Enter');
  earnFake(other);
  earnFake(g);
  need(other.slot === 1 && saveNow(1).id === other.saveId && g.slot === 2 && saveNow(2).id === g.saveId
    && g.noteText === 'SAVED IN SLOT 2' && g.noteTicks === NOTE_TICKS, 'M11F the first coin after another game filled slot 1 takes slot 2 and notes it');
  // M11U: slot 1 alone free; the other game's first coin takes it.
  fresh(g, '.vv');
  keyTo(g, 'Enter', 'Enter');
  const second = reload();
  keyTo(second, 'Enter', 'Enter');
  earnFake(second);
  const full = savesText();
  earnFake(g);
  need(g.saveId === null && !g.armed && savesText() === full && g.noteText === NOT_SAVED && g.noteTicks === NOTE_TICKS,
    'M11U the first coin after another game filled the last free slot notes NOT SAVED: PAUSE TO SAVE');
  g.noteTicks = 0;
  earnFake(g);
  need(g.saveId === null && savesText() === full && g.noteTicks === 0, 'M11U the unsaved run writes nothing more by itself');
}

/**
 * M1, BEGIN: over a free slot the first coin takes the lowest and notes it for
 * 120 ticks of play; over three full slots the pick marks a slot that the
 * first coin overwrites; with no slot writable the run plays unsaved.
 */
function m1Leg(g, { need }) {
  // M1F: slot 1 used, slots 2 and 3 free.
  fresh(g, 'v..');
  const before = savesText();
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'play' && g.armed && g.saveId === null && savesText() === before, 'M1F BEGIN over a free slot asks nothing and writes nothing');
  earnFake(g);
  need(g.slot === 2 && saveNow(2).id === g.saveId && heldSave(3).state === 'absent' && savesText().startsWith(before.split('\u0001')[0]),
    'M1F the first coin takes slot 2, the lowest free');
  need(g.noteText === 'SAVED IN SLOT 2' && g.noteTicks > 0, 'M1F the first coin notes SAVED IN SLOT 2');
  draw(g, 0);
  need(noteDrawn(), 'M1F the note draws in play');
  stand(g, 60);
  need(g.noteTicks === 60, 'M1F the note keeps 60 of its 120 ticks after 60 ticks of play');
  keyTo(g, 'KeyP', 'p');
  for (let i = 0; i < 30; i++) tick(g);
  keyTo(g, 'KeyP', 'p');
  need(g.noteTicks === 60, 'M1F a pause holds the note');
  stand(g, 59);
  draw(g, 0);
  need(noteDrawn(), 'M1F the note still draws on its 120th tick of play');
  stand(g, 1);
  draw(g, 0);
  need(g.noteTicks === 0 && !noteDrawn(), 'M1F the note lasts 120 ticks of play');

  // M1U: all three full, slot 2 played least recently.
  fresh(g, 'vvv', { 2: { played: PLAYED } });
  const full = savesText();
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'pick' && g.row === 1 && savesText() === full, 'M1U BEGIN over three full slots opens the pick, its cursor on the least recently played');
  keyTo(g, 'Enter', 'Enter', true);
  keyTo(g, 'KeyY', 'y', true);
  keyTo(g, 'Enter', 'Enter', true);
  need(g.screen === 'pick' && g.confirm === null && g.mark === null && savesText() === full, 'M1U a held Enter from the title marks no slot');
  keyTo(g, 'Enter', 'Enter');
  need(g.confirm !== null && g.confirm.kind === 'overwrite' && g.confirm.n === 2, 'M1U Enter asks OVERWRITE SLOT 2?');
  keyTo(g, 'Enter', 'Enter', true);
  keyTo(g, 'KeyY', 'y', true);
  need(g.screen === 'pick' && g.confirm !== null && g.mark === null && savesText() === full, 'M1U OVERWRITE SLOT 2? ignores a repeated Y and Enter');
  keyTo(g, 'KeyN', 'n');
  need(g.screen === 'pick' && g.confirm === null, 'M1U N at OVERWRITE SLOT 2? returns to the pick');
  keyTo(g, 'Digit2', '2');
  keyTo(g, 'KeyY', 'y');
  need(g.screen === 'play' && g.mark !== null && g.mark.n === 2 && g.mark.id === slotId(2) && g.saveId === null && savesText() === full,
    'M1U Y marks slot 2 and writes nothing before the first coin');
  earnFake(g);
  need(g.slot === 2 && saveNow(2).id === g.saveId && g.saveId !== slotId(2) && saveNow(1).id === slotId(1) && saveNow(3).id === slotId(3)
    && g.noteText === 'SAVED IN SLOT 2', 'M1U the first coin overwrites slot 2 alone');
  // Y over a slot another game rewrote under another id redraws; over a slot emptied since, BEGIN's rules run again.
  fresh(g, 'vvv');
  keyTo(g, 'Enter', 'Enter');
  keyTo(g, 'Digit1', '1');
  putSave(1, { id: 'DDDDDDDD', wallet: 9 });
  keyTo(g, 'KeyY', 'y');
  need(g.screen === 'pick' && g.confirm !== null && g.confirm.held.record.id === 'DDDDDDDD' && g.mark === null,
    'M1U Y over a slot rewritten under another id redraws OVERWRITE SLOT 1?');
  unstore(saveKey(1));
  keyTo(g, 'KeyY', 'y');
  need(g.screen === 'play' && g.armed && g.mark === null, 'M1U Y over a slot emptied since starts the run under the free-slot rule');

  // M1N: three NEWER slots, then storage refusing writes over free ones.
  for (const [what, spec, warning] of [['three NEWER slots', 'nnn', 'SAVES FROM A NEWER GAME: RELOAD'], ['storage refusing writes', '...', 'SAVES OFF: COPY YOUR CODE']]) {
    fresh(g, spec);
    if (spec === '...') refuse(true);
    const kept = savesText();
    keyTo(g, 'Enter', 'Enter');
    need(g.screen === 'play' && savesText() === kept, `M1N BEGIN over ${what} plays unsaved and asks nothing`);
    earnFake(g);
    need(g.saveId === null && g.noteTicks === 0 && savesText() === kept, `M1N over ${what} the first coin writes nothing and notes nothing`);
    keyTo(g, 'KeyP', 'p');
    need(g.screen === 'pause' && !saveOffered(g), `M1N over ${what} the pause offers no SAVE`);
    keyTo(g, 'KeyQ', 'q');
    need(titleWarning() === warning, `M1N over ${what} the title warns of the cause`);
    refuse(false);
  }
  // The take that does not land: writes refused after BEGIN over a free slot.
  fresh(g, '...');
  keyTo(g, 'Enter', 'Enter');
  refuseWrites = true;
  earnFake(g);
  need(g.saveId === null && g.slot === null && g.noteTicks === 0 && heldSave(1).state === 'absent', 'M1N a take whose store does not land binds nothing and notes nothing');
  keyTo(g, 'KeyP', 'p');
  keyTo(g, 'KeyQ', 'q');
  need(titleWarning() === 'SAVES OFF: COPY YOUR CODE', 'M1N the title then reads SAVES OFF: COPY YOUR CODE');
  refuse(false);
}

/** M2, a typed seed on LOAD becomes the title's shown seed, and LOAD returns to the title. */
function m2Leg(g, { need }) {
  for (const [cell, spec] of [['M2F', 'v..'], ['M2U', 'vvv'], ['M2N', 'nnn']]) {
    fresh(g, spec);
    const kept = savesText();
    typeIn(g, '2222-3333');
    need(g.screen === 'title' && g.code === '22223333' && g.typing === null && savesText() === kept, `${cell} a typed seed becomes the shown seed, back on the title`);
  }
}

/** M10, P on the title resumes the open run, and with none open does nothing. */
function m10Leg(g, { need }) {
  for (const [cell, spec] of [['M10F', 'v..'], ['M10U', 'vvv'], ['M10N', 'nnn']]) {
    fresh(g, spec);
    const sim = g.sim, kept = savesText();
    keyTo(g, 'KeyP', 'p');
    need(g.screen === 'title' && g.sim === sim && g.confirm === null && savesText() === kept, `${cell} P with no run open does nothing`);
    begin(g);
    const run = g.sim;
    leaveOpen(g);
    keyTo(g, 'KeyP', 'p');
    need(g.screen === 'play' && g.sim === run, `${cell} P on the title resumes the open run`);
  }
}

/** M6, Enter on a valid LOAD row loads it at once at its level, TOMB n and coins, bound to its slot. */
function m6Leg(g, { need }) {
  const two = startSerial();
  for (const [cell, spec] of [['M6F', 'vv.'], ['M6U', 'vvv']]) {
    fresh(g, spec, { 2: { save: two, level: 'hard', net: 30, high: 31, wallet: 310 } });
    setDifficulty(g, 'easy');
    const kept = savesText();
    keyTo(g, 'KeyT', 't');
    for (let i = 0; i < 3; i++) keyTo(g, 'ArrowUp', 'ArrowUp');
    keyTo(g, 'ArrowDown', 'ArrowDown');
    keyTo(g, 'Enter', 'Enter');
    need(g.screen === 'play' && g.slot === 2 && g.saveId === slotId(2) && g.world.difficulty === 'hard' && g.difficulty === 'hard'
      && tombCount(g.sim) === 31 && g.sim.net === 30 && g.wallet === 310 && g.point.save === two && savesText() === kept,
    `${cell} Enter on slot 2's row loads it at its level, TOMB n and coins`);
  }
}

/** M7, Enter on the open run's own row resumes it, with no rebuild. */
function m7Leg(g, { need }) {
  // Slot 1 was played ahead of the clock, so its row, not the open run's, is the most recently played.
  for (const [cell, spec] of [['M7F', 'v..'], ['M7U', 'vv.']]) {
    fresh(g, spec, { 1: { played: Date.UTC(2100, 0, 1) } });
    keyTo(g, 'Enter', 'Enter');
    earnFake(g);
    const n = g.slot, run = g.sim;
    run.burn = BURN_S / 3;
    keyTo(g, 'KeyP', 'p');
    keyTo(g, 'KeyQ', 'q');
    keyTo(g, 'KeyT', 't');
    need(g.screen === 'load' && n !== null && g.row === n - 1, `${cell} LOAD's cursor starts on the open run's own row`);
    keyTo(g, 'Enter', 'Enter');
    need(g.screen === 'play' && g.sim === run && run.burn === BURN_S / 3, `${cell} Enter on the open run's own row resumes the same run, its burn unchanged`);
  }
}

/** M22, a serial of a slot's seed at another board, from earlier in its run, matches no slot: a new run, as row 4. */
function m22Leg(g, { need }) {
  fresh(g, 'v..', { 1: { save: startSerial(), net: 5, high: 5, wallet: 50 } });
  typeIn(g, exitSerial());
  need(g.screen === 'play' && tombCount(g.sim) === 0 && g.wallet === 0 && g.slot === null, 'M22 another save code starts at TOMB 0');
}

/** M21, a serial that two slots hold loads the lower. */
function m21Leg(g, { need }) {
  const s = startSerial();
  fresh(g, 'v.v', { 1: { save: s, wallet: 11 }, 3: { save: s, wallet: 33 } });
  typeIn(g, s);
  need(g.screen === 'play' && g.slot === 1 && g.saveId === slotId(1) && g.wallet === 11, 'M21 a serial in two slots loads the lower');
}

/** M3, a typed serial matching a valid slot loads that slot at its level, and over full slots overwrites nothing. */
function m3Leg(g, { need }) {
  const two = startSerial();
  for (const [cell, spec] of [['M3F', 'vv.'], ['M3U', 'vvv']]) {
    fresh(g, spec, { 2: { save: two, level: 'hard', net: 5, high: 6, wallet: 60 } });
    setDifficulty(g, 'easy');
    const kept = savesText();
    typeIn(g, two);
    need(g.screen === 'play' && g.slot === 2 && g.saveId === slotId(2) && g.world.difficulty === 'hard' && tombCount(g.sim) === 6
      && g.wallet === 60 && savesText() === kept, `${cell} a typed serial matching slot 2 loads slot 2 at its level, writing nothing`);
  }
}

/**
 * M5, the typed serial of the open run resumes it with no rebuild: through
 * its own row when the run is bound and its slot holds the serial, and as the
 * open run's serial when it holds no slot.
 */
function m5Leg(g, { need }) {
  // Pauses the run, which writes a bound run's serial, and leaves it open with its torch at a third; the
  // typed serial must resume it unchanged.
  const resumes = (cell, what, refused = false) => {
    const run = g.sim;
    run.burn = BURN_S / 3;
    keyTo(g, 'KeyP', 'p');
    const serial = hereCode(g);
    if (refused) refuse(true);
    keyTo(g, 'KeyQ', 'q');
    typeIn(g, serial);
    need(g.screen === 'play' && g.sim === run && run.burn === BURN_S / 3, `${cell} the typed serial of ${what} resumes it, its burn unchanged`);
    refuse(false);
  };
  // Bound: BEGIN's run takes slot 1 at its first coin.
  for (const [cell, spec, refused] of [['M5F', '...', false], ['M5U', '.vv', false], ['M5N', '...', true]]) {
    fresh(g, spec);
    keyTo(g, 'Enter', 'Enter');
    earnFake(g);
    resumes(cell, `a bound open run whose slot holds it${refused ? ', storage refusing writes' : ''}`, refused);
  }
  // Unbound: the free-slot rule armed, a marked run, a run over three NEWER slots.
  fresh(g, 'v..');
  keyTo(g, 'Enter', 'Enter');
  resumes('M5F', 'an open run holding no slot');
  fresh(g, 'vvv');
  keyTo(g, 'Enter', 'Enter');
  keyTo(g, 'Digit1', '1');
  keyTo(g, 'KeyY', 'y');
  resumes('M5U', 'a marked open run');
  fresh(g, 'nnn');
  keyTo(g, 'Enter', 'Enter');
  resumes('M5N', 'an open run over three NEWER slots');
}

/** M4, a typed serial matching no slot starts a run at the setting under BEGIN's rules, as row 1. */
function m4Leg(g, { need }) {
  const elsewhere = exitSerial();
  // M4F: slot 1 used.
  fresh(g, 'v..');
  setDifficulty(g, 'easy');
  let kept = savesText();
  typeIn(g, elsewhere);
  need(g.screen === 'play' && g.world.difficulty === 'easy' && tombCount(g.sim) === 0 && g.armed && savesText() === kept,
    'M4F a typed serial matching no slot starts a run at the setting, asking nothing');
  earnFake(g);
  need(g.slot === 2 && saveNow(2).id === g.saveId && g.noteText === 'SAVED IN SLOT 2', 'M4F its first coin takes slot 2 and notes it');
  // M4U: all three full.
  fresh(g, 'vvv');
  kept = savesText();
  typeIn(g, elsewhere);
  need(g.screen === 'pick' && g.pick.p === decodeSave(elsewhere).p && savesText() === kept, 'M4U a typed serial matching no slot opens the pick first');
  keyTo(g, 'Digit1', '1');
  keyTo(g, 'KeyY', 'y');
  need(g.screen === 'play' && g.mark !== null && g.mark.n === 1 && hereCode(g) === elsewhere && savesText() === kept, 'M4U Y starts the typed run marked for slot 1');
  earnFake(g);
  need(g.slot === 1 && saveNow(1).id === g.saveId, 'M4U its first coin overwrites slot 1');
  // M4N: three NEWER slots, then storage refusing writes.
  for (const [what, spec, warning] of [['three NEWER slots', 'nnn', 'SAVES FROM A NEWER GAME: RELOAD'], ['storage refusing writes', '...', 'SAVES OFF: COPY YOUR CODE']]) {
    fresh(g, spec);
    if (spec === '...') refuse(true);
    kept = savesText();
    typeIn(g, elsewhere);
    need(g.screen === 'play' && savesText() === kept, `M4N over ${what} a typed serial matching no slot plays unsaved and asks nothing`);
    earnFake(g);
    need(g.saveId === null && g.noteTicks === 0 && savesText() === kept, `M4N over ${what} its first coin writes nothing and notes nothing`);
    keyTo(g, 'KeyP', 'p');
    need(!saveOffered(g), `M4N over ${what} the pause offers no SAVE`);
    keyTo(g, 'KeyQ', 'q');
    need(titleWarning() === warning, `M4N over ${what} the title warns of the cause`);
    refuse(false);
  }
}

/**
 * M9, every action that would discard an open run unsaved with progress asks
 * LEAVE UNSAVED RUN? first: BEGIN, a typed save code that loads a slot or
 * starts a run, and a load by Enter, a digit or a touch SLOT key. N returns to
 * the screen that asked, and Y carries the action on.
 */
function m9Leg(g, { need, click }) {
  const elsewhere = exitSerial();
  // Each action, the screen it asks from, and what its yes makes of the open run `run`.
  const loaded = (n) => (run) => g.screen === 'play' && g.slot === n && g.sim !== run && g.open === null;
  const started = (run) => g.screen === 'play' && g.sim !== run && g.open === null && g.armed;
  const picked = () => g.screen === 'pick';
  const onLoad = () => { if (g.screen === 'title') keyTo(g, 'KeyT', 't'); };
  const actions = {
    BEGIN: [() => keyTo(g, 'Enter', 'Enter'), 'title'],
    'a typed save code that loads slot 2': [() => typeIn(g, startSerial()), 'load'],
    'a typed save code that starts a run': [() => typeIn(g, elsewhere), 'load'],
    'Enter on slot 2\'s row': [() => {
      onLoad();
      for (const dir of ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowDown']) keyTo(g, dir, dir);
      keyTo(g, 'Enter', 'Enter');
    }, 'load'],
    'the digit 2': [() => { onLoad(); keyTo(g, 'Digit2', '2'); }, 'load'],
    'the SLOT 2 key': [() => { onLoad(); softTap(g, click, 'load', 's2'); }, 'load'],
  };
  const asks = (cell, spec, what, done) => {
    const [act, back] = actions[what];
    fresh(g, spec, { 2: { save: startSerial() } });
    const run = openUnsaved(g);
    act();
    need(g.confirm !== null && g.confirm.kind === 'leave' && g.screen === back && g.open !== null && g.open.sim === run, `${cell} ${what} asks LEAVE UNSAVED RUN?`);
    keyTo(g, 'KeyN', 'n');
    need(g.confirm === null && g.screen === back && g.open !== null && g.open.sim === run, `${cell} N at LEAVE UNSAVED RUN? after ${what} returns where it asked`);
    act();
    keyTo(g, 'KeyY', 'y');
    need(done(run), `${cell} Y at LEAVE UNSAVED RUN? carries ${what} on`);
    return run;
  };
  // A run whose slot another game took holds none.
  fresh(g, '...');
  keyTo(g, 'Enter', 'Enter');
  earnFake(g);
  keyTo(g, 'KeyP', 'p');
  keyTo(g, 'KeyQ', 'q');
  putSave(1, { id: 'DDDDDDDD' });
  keyTo(g, 'Enter', 'Enter');
  need(g.confirm !== null && g.confirm.kind === 'leave', 'M9F BEGIN over an open run whose slot another game took asks LEAVE UNSAVED RUN?');
  asks('M9F', 'vv.', 'BEGIN', started);
  asks('M9F', 'vv.', 'a typed save code that loads slot 2', loaded(2));
  asks('M9F', 'vv.', 'a typed save code that starts a run', started);
  for (const what of ['Enter on slot 2\'s row', 'the digit 2', 'the SLOT 2 key']) asks('M9F', 'vv.', what, loaded(2));
  // Over three full slots the yes reaches the pick, and backing out of it keeps the run open.
  for (const what of ['BEGIN', 'a typed save code that starts a run']) {
    const run = asks('M9U', 'vvv', what, picked);
    keyTo(g, 'KeyQ', 'q');
    need(g.screen === 'title' && g.open !== null && g.open.sim === run, `M9U backing out of the pick after ${what} keeps the run open`);
  }
  asks('M9U', 'vvv', 'a typed save code that loads slot 2', loaded(2));
  for (const what of ['Enter on slot 2\'s row', 'the digit 2', 'the SLOT 2 key']) asks('M9U', 'vvv', what, loaded(2));
  for (const what of ['BEGIN', 'a typed save code that starts a run']) asks('M9N', 'nnn', what, started);
}

/** M12, another game overwrites or removes a bound run's slot: its next write takes the next free slot, or none. */
function m12Leg(g, { need }) {
  // M12F: the run takes slot 1; slot 2 free, slot 3 used.
  fresh(g, '..v');
  keyTo(g, 'Enter', 'Enter');
  earnFake(g);
  putSave(1, { id: 'DDDDDDDD', wallet: 9 });
  const theirs = load(saveKey(1));
  earnFake(g);
  need(load(saveKey(1)) === theirs, 'M12F the first game\'s next write stores nothing after another tab\'s overwrite');
  need(g.slot === 2 && saveNow(2).id === g.saveId && g.noteText === 'SAVED IN SLOT 2', 'M12F a run whose slot another game overwrote takes slot 2 at its next write and notes it');
  // A stale page of revision 1 removes the run's slot, which its next write takes again under a fresh id.
  const was = g.saveId;
  unstore(saveKey(2));
  g.noteTicks = 0;
  earnFake(g);
  need(g.slot === 2 && saveNow(2).id === g.saveId && g.saveId !== was && g.noteTicks === NOTE_TICKS, 'M12F a run whose slot another game removed takes the lowest free slot again and notes it');
  // M12U: slots 2 and 3 used; the run takes slot 1, which another game overwrites.
  fresh(g, '.vv');
  keyTo(g, 'Enter', 'Enter');
  earnFake(g);
  putSave(1, { id: 'DDDDDDDD' });
  const full = savesText();
  earnFake(g);
  need(savesText() === full && g.saveId === null && g.noteText === NOT_SAVED && g.noteTicks === NOTE_TICKS,
    'M12U a run whose slot another game overwrote, all three full, notes NOT SAVED: PAUSE TO SAVE');
  // M12N: a newer build writes over the run's slot beside two NEWER slots; another game removes it while
  // storage refuses writes.
  for (const [what, spec, warning] of [['three NEWER slots', '.nn', 'SAVES FROM A NEWER GAME: RELOAD'], ['storage refusing writes', '...', 'SAVES OFF: COPY YOUR CODE']]) {
    fresh(g, spec);
    keyTo(g, 'Enter', 'Enter');
    earnFake(g);
    if (spec === '.nn') store(saveKey(1), NEWER_TEXT);
    else {
      unstore(saveKey(1));
      refuse(true);
    }
    const kept = savesText();
    g.noteTicks = 0;
    earnFake(g);
    need(g.saveId === null && g.noteTicks === 0 && savesText() === kept, `M12N over ${what} a run whose slot another game took plays on unsaved and notes nothing`);
    keyTo(g, 'KeyP', 'p');
    need(!saveOffered(g), `M12N over ${what} the pause offers no SAVE`);
    keyTo(g, 'KeyQ', 'q');
    need(titleWarning() === warning, `M12N over ${what} the title warns of the cause`);
    refuse(false);
  }
}

/** M13, the marked slot changes before the run's first write: the free-slot rule, and with no slot free, none. */
function m13Leg(g, { need }) {
  // M13F: the pick marks slot 2, which another game rewrites under its own id; slot 3 then empties.
  fresh(g, 'vvv');
  keyTo(g, 'Enter', 'Enter');
  keyTo(g, 'Digit2', '2');
  keyTo(g, 'KeyY', 'y');
  putSave(2, { id: 'DDDDDDDD' });
  unstore(saveKey(3));
  const theirs = load(saveKey(2));
  earnFake(g);
  need(load(saveKey(2)) === theirs && g.slot === 3 && saveNow(3).id === g.saveId && g.noteText === 'SAVED IN SLOT 3',
    'M13F the first coin leaves a marked slot another game rewrote, and the free-slot rule takes slot 3');
  // M13U: the same rewrite with all three still full.
  fresh(g, 'vvv');
  keyTo(g, 'Enter', 'Enter');
  keyTo(g, 'Digit2', '2');
  keyTo(g, 'KeyY', 'y');
  putSave(2, { id: 'DDDDDDDD' });
  const full = savesText();
  earnFake(g);
  need(savesText() === full && g.saveId === null && g.mark === null && g.noteText === NOT_SAVED,
    'M13U the first coin over a marked slot another game rewrote, all three full, notes NOT SAVED: PAUSE TO SAVE');
}

/** M14, a quit, a death or a reload before the first coin writes no slot, and leaves a marked slot whole. */
function m14Leg(g, { need }) {
  for (const [cell, spec, mark] of [['M14F', 'v..', false], ['M14U', 'vvv', true]]) {
    fresh(g, spec);
    const kept = savesText();
    keyTo(g, 'Enter', 'Enter');
    if (mark) {
      keyTo(g, 'Digit2', '2');
      keyTo(g, 'KeyY', 'y');
    }
    keyTo(g, 'KeyP', 'p');
    keyTo(g, 'KeyQ', 'q');
    need(g.screen === 'title' && savesText() === kept, `${cell} a PAUSE and Q before the first coin leave every slot as it was`);
    keyTo(g, 'KeyP', 'p');
    die(g);
    need(g.screen === 'over' && savesText() === kept, `${cell} a death before the first coin leaves every slot as it was`);
    reload();
    need(savesText() === kept, `${cell} a reload before the first coin leaves every slot as it was`);
  }
}

/**
 * M15, SAVE on the pause of a run holding no slot: SAVE IN? lists the free
 * rows first and binds there; over full slots a used row asks OVERWRITE SLOT
 * n?; with no slot writable the pause offers no SAVE.
 */
function m15Leg(g, { need, click }) {
  const tap = (sid, which) => softTap(g, click, sid, which);
  // M15F: another game fills slot 1 before the run's first coin, which finds all three full and pays in
  // memory; slot 2 is then damaged and slot 3 emptied.
  fresh(g, '.vv');
  keyTo(g, 'Enter', 'Enter');
  putSave(1, { id: 'DDDDDDDD' });
  earnFake(g);
  store(saveKey(2), '{not json');
  unstore(saveKey(3));
  const slot1 = load(saveKey(1));
  keyTo(g, 'KeyP', 'p');
  draw(g, 0);
  need(g.screen === 'pause' && g.saveId === null && touch.soft('pause', 'save').getBoundingClientRect().width > 0, 'the unsaved pause shows SAVE');
  tap('pause', 'save');
  need(g.screen === 'savein', 'SAVE on the unsaved pause opens SAVE IN?');
  need(g.saveIn.order === '231' && g.saveIn.cursor === 0, 'M15F SAVE IN? lists the free rows first, the DAMAGED one among them, the cursor on the first');
  const before = savesText();
  keyTo(g, 'Space', ' ');
  keyTo(g, 'KeyP', 'p');
  keyTo(g, 'Enter', 'Enter', true);
  need(g.screen === 'savein' && g.saveId === null && savesText() === before, 'Space, P and an auto-repeated Enter answer nothing on SAVE IN?');
  keyTo(g, 'KeyQ', 'q');
  need(g.screen === 'pause' && g.saveId === null, 'Q returns SAVE IN? to the unsaved pause');
  keyTo(g, 'Enter', 'Enter');
  tap('savein', 's3');
  need(g.screen === 'pause' && g.slot === 3 && saveNow(3) !== null && saveNow(3).id === g.saveId && saveNow(3).wallet === 1
    && load(saveKey(1)) === slot1 && heldSave(2).state === 'damaged', 'picking an empty row stores the wallet the run held, no more');

  // M15U: all three full; the pick marks slot 2, and the marked run pauses UNSAVED before its first coin.
  fresh(g, 'vvv');
  const full = savesText();
  keyTo(g, 'Enter', 'Enter');
  keyTo(g, 'Digit2', '2');
  keyTo(g, 'KeyY', 'y');
  keyTo(g, 'KeyP', 'p');
  need(g.screen === 'pause' && g.saveId === null && saveOffered(g), 'M15U a marked run pauses UNSAVED and offers SAVE');
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'savein' && g.saveIn.order === '123', 'M15U SAVE IN? lists the used slots in row order');
  keyTo(g, 'Enter', 'Enter');
  need(g.confirm !== null && g.confirm.kind === 'overwrite' && g.confirm.n === 1 && savesText() === full, 'M15U a used row asks OVERWRITE SLOT 1?');
  keyTo(g, 'KeyN', 'n');
  need(g.screen === 'savein' && g.confirm === null && savesText() === full, 'N at OVERWRITE returns to SAVE IN?');
  keyTo(g, 'Enter', 'Enter');
  putSave(1, { id: 'DDDDDDDD', wallet: 9 });
  const rewritten = load(saveKey(1));
  keyTo(g, 'KeyY', 'y');
  need(g.screen === 'savein' && g.confirm !== null && g.confirm.held.record.id === 'DDDDDDDD' && load(saveKey(1)) === rewritten && g.saveId === null,
    'OVERWRITE redraws at Y with the stored record and writes nothing');
  keyTo(g, 'KeyY', 'y');
  need(g.screen === 'pause' && g.slot === 1 && saveNow(1).id === g.saveId && g.mark === null && saveNow(2).id === slotId(2) && saveNow(3).id === slotId(3),
    'OVERWRITE\'s Y writes that slot alone');
  // A NEWER slot is never listed.
  fresh(g, 'vnv');
  keyTo(g, 'Enter', 'Enter');
  keyTo(g, 'Digit1', '1');
  keyTo(g, 'KeyY', 'y');
  keyTo(g, 'KeyP', 'p');
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'savein' && g.saveIn.order === '13', 'SAVE IN? does not list a NEWER slot');
  need(load(saveKey(2)) === NEWER_TEXT, 'a NEWER slot\'s stored text is unchanged after the leg');

  // M15N: three NEWER slots, then storage refusing writes over free ones.
  for (const [what, spec] of [['three NEWER slots', 'nnn'], ['storage refusing writes', '...']]) {
    fresh(g, spec);
    keyTo(g, 'Enter', 'Enter');
    if (spec === '...') refuse(true);
    keyTo(g, 'KeyP', 'p');
    draw(g, 0);
    need(g.screen === 'pause' && g.saveId === null && touch.soft('pause', 'save').getBoundingClientRect().width === 0, `M15N over ${what} the unsaved pause offers no SAVE`);
    keyTo(g, 'Enter', 'Enter');
    need(g.screen === 'pause', `M15N over ${what} Enter on the pause opens nothing`);
    refuse(false);
  }
}

/**
 * M16, a torch death, then Continue: the run keeps its slot and counts one
 * continue, and with no slot writable plays on unsaved. Only a death raises
 * the count: each death ends the torch through the sim, so the tick's own
 * endRun writes, where a bare endRun leaves the run live and stores no rise.
 */
function m16Leg(g, { need, click, press }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const serial = startSerial();
  // Slot 1 holds 300 coins and TOMB 20 at tomb (0, 0)'s first board; slots 2 and 3 are empty.
  const toStart = () => {
    clearSaves();
    putSave(1, { save: serial, net: 20, high: 20, wallet: 300 });
    cleanState(g);
    openTitle(g);
  };
  const restored = () => g.screen === 'play' && g.slot === 1 && g.saveId === SAVE_BASE.id && g.wallet === 300 && tombCount(g.sim) === 20;
  toStart();
  press('KeyT', 't');
  press('Digit1', '1');
  need(restored() && g.sim.continues === 0, 'a load restores a slot at 0 continues');
  die(g);
  draw(g, 0);
  click('over', 'continue');
  need(g.screen === 'play' && g.sim.continues === 1 && g.slot === 1 && g.saveId === SAVE_BASE.id,
    'M16F a death and CONTINUE raise the continue count to 1 and keep slot 1');
  press('KeyP', 'p');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim.continues === 1, 'P and P hold the continue count at 1');
  press('KeyP', 'p');
  press('KeyQ', 'q');
  press('KeyP', 'p');
  need(g.screen === 'play' && g.sim.continues === 1, 'Q, the title and RESUME hold the continue count at 1');
  die(g);
  need(g.sim.continues === 1 && saveNow(1).continues === 2, 'a second death stores 2 in the slot while the end screen shows 1');
  draw(g, 0);
  press('KeyQ', 'q');
  need(g.screen === 'title', 'Q leaves the end screen for the title');
  press('KeyT', 't');
  press('Digit1', '1');
  need(restored() && g.sim.continues === 2, 'Q and a load restore the stored count of 2');
  draw(g, 0);
  click('play', 'pause');
  const after = reload();
  loadSlot(after, 1);
  need(after.screen === 'play' && after.sim.continues === 2 && saveNow(1).continues === 2, 'a PAUSE, a reload and a load hold the count at 2');
  openTitle(g);
  click('title', 'begin');
  need(g.screen === 'play' && g.sim.continues === 0, 'BEGIN starts the continue count at 0');
  // Two live games on one save share the count by maximum: one dies, the other's next write adopts the rise.
  toStart();
  press('KeyT', 't');
  press('Digit1', '1');
  const twin = reload();
  loadSlot(twin, 1);
  need(restored() && twin.screen === 'play' && twin.sim.continues === 0, 'two games restore one slot at 0 continues');
  die(g);
  need(saveNow(1).continues === 1 && twin.sim.continues === 0, 'a death stores the raised count before the other game writes');
  commit(twin, twin.point);
  need(twin.sim.continues === 1 && saveNow(1).continues === 1, 'a live game adopts another\'s death on its next write');
  // M16U: all three full.
  fresh(g, 'vvv');
  loadSlot(g, 1);
  die(g);
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'play' && g.slot === 1 && g.saveId === slotId(1) && g.sim.continues === 1 && saveNow(1).continues === 1,
    'M16U a death and CONTINUE over three full slots keep slot 1 and count one continue');
  // M16N: three NEWER slots.
  fresh(g, 'nnn');
  const kept = savesText();
  keyTo(g, 'Enter', 'Enter');
  earnFake(g);
  die(g);
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'play' && g.saveId === null && g.sim.continues === 1 && g.noteTicks === 0 && savesText() === kept,
    'M16N a death and CONTINUE over three NEWER slots play on unsaved, writing nothing and noting nothing');
  keyTo(g, 'KeyP', 'p');
  need(!saveOffered(g), 'M16N the pause offers no SAVE');
  keyTo(g, 'KeyQ', 'q');
  need(titleWarning() === 'SAVES FROM A NEWER GAME: RELOAD', 'M16N the title warns of a newer game\'s saves');
}

/** M17, BEGIN after loading slot 1 and Q: a new run that leaves slot 1 whole, or over full slots the pick offering slot 1. */
function m17Leg(g, { need }) {
  fresh(g, 'v..');
  loadSlot(g, 1);
  keyTo(g, 'KeyP', 'p');
  keyTo(g, 'KeyQ', 'q');
  const one = load(saveKey(1));
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'play' && g.armed && g.slot === null && load(saveKey(1)) === one, 'M17F BEGIN after a load and Q starts a new run, slot 1 untouched');
  earnFake(g);
  need(g.slot === 2 && saveNow(2).id === g.saveId && load(saveKey(1)) === one, 'M17F the new run\'s first coin takes slot 2, slot 1 untouched');
  fresh(g, 'vvv');
  loadSlot(g, 1);
  keyTo(g, 'KeyP', 'p');
  keyTo(g, 'KeyQ', 'q');
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'pick' && g.open !== null, 'M17U BEGIN after a load and Q over three full slots opens the pick');
  keyTo(g, 'Digit1', '1');
  need(g.confirm !== null && g.confirm.kind === 'overwrite' && g.confirm.n === 1, 'M17U the pick offers slot 1, the loaded save');
}

/** M18, two games on one slot under one id merge by maximum, and each adopts the merged high at its next write. */
function m18Leg(g, { need }) {
  // A counted rise of game `h`'s high to `to`, written through the game's own tick write.
  const rise = (h, to) => {
    const was = tombCount(h.sim);
    h.sim.net = to;
    h.sim.high = to;
    tickSave(h, 0, was, false, false);
  };
  for (const [cell, spec] of [['M18F', 'v..'], ['M18U', 'vvv']]) {
    fresh(g, spec, { 1: { save: startSerial(), net: 2, high: 2, wallet: 10 } });
    restore(g, 1, saveNow(1));
    const b = reload();
    restore(b, 1, saveNow(1));
    rise(g, 5);
    earnFake(b);
    need(saveNow(1).high === 5 && saveNow(1).wallet === 10 + 3 * COIN_RATE.medium + 1 && b.wallet === saveNow(1).wallet,
      `${cell} two games on one slot merge the wallet and the high by maximum`);
    need(tombCount(b.sim) === 5, `${cell} game B's next write adopts the high game A raised, and B's TOMB n shows it`);
  }
}

/** M20, a loaded save plays at its own level; L on the title changes only new runs; TOMB n never carries across levels. */
function m20Leg(g, { need }) {
  fresh(g, 'vv.', { 1: { save: startSerial(), level: 'hard', net: 4, high: 4 }, 2: { save: exitSerial(), level: 'medium', net: 9, high: 9 } });
  setDifficulty(g, 'easy');
  loadSlot(g, 1);
  need(g.world.difficulty === 'hard' && g.world.size.w === 4 && tombCount(g.sim) === 4, 'M20 a loaded save plays at its level whatever the title shows');
  keyTo(g, 'KeyP', 'p');
  keyTo(g, 'KeyQ', 'q');
  keyTo(g, 'KeyL', 'l');
  need(g.difficulty === 'ultimate' && g.open !== null && g.open.world.difficulty === 'hard', 'M20 L on the title changes only new runs');
  loadSlot(g, 2);
  need(g.screen === 'play' && g.world.difficulty === 'medium' && g.difficulty === 'medium' && tombCount(g.sim) === 9,
    'M20 a load over an open run at another level plays at the save\'s level');
  keyTo(g, 'KeyP', 'p');
  keyTo(g, 'KeyQ', 'q');
  keyTo(g, 'KeyL', 'l');
  keyTo(g, 'Enter', 'Enter');
  need(g.screen === 'play' && g.world.difficulty === 'hard' && tombCount(g.sim) === 0, 'M20 BEGIN at another level starts at TOMB 0');
}

/**
 * M24, revision 1's beta records: a record with no `played` reads valid,
 * loads, and its row shows no time; its next write adds `played`. Boot shows
 * the seed of the most recently played valid slot, and of the lowest valid
 * slot when none carries `played`.
 */
function m24Leg(g, { need }) {
  fresh(g, 'vv.', { 2: { played: undefined } });
  need(heldSave(2).state === 'valid' && heldSave(2).record.played === undefined, 'M24 a record with no played reads valid');
  keyTo(g, 'KeyT', 't');
  for (let i = 0; i < 3; i++) keyTo(g, 'ArrowDown', 'ArrowDown');
  draw(g, 0);
  need(timeBlank(2) && !timeBlank(1), 'M24 its row shows no time, where a played row shows one');
  keyTo(g, 'Digit2', '2');
  need(g.screen === 'play' && g.slot === 2 && g.saveId === slotId(2), 'M24 a record with no played loads');
  keyTo(g, 'KeyP', 'p');
  need(Number.isSafeInteger(saveNow(2).played), 'M24 its next write adds played');
  const a = encodeSave('22223333', 0, 0), b = encodeSave('44445555', 0, 0);
  fill('.vv', { 2: { save: b, played: PLAYED + HOUR }, 3: { save: a, played: PLAYED } });
  need(reload().code === '44445555', 'M24 boot shows the seed of the most recently played valid slot');
  fill('.vv', { 2: { save: a, played: undefined }, 3: { save: b, played: undefined } });
  need(reload().code === '22223333', 'M24 boot shows the lowest valid slot\'s seed when none carries played');
}

/**
 * M26, the farming loops, at MEDIUM. A is tomb (0, 0) and B the tomb its exit
 * leads to; each run starts on A's exit board, which is no entry, and crosses
 * its exit door into B, raising the high to 1. Stepping back onto that board,
 * a PAUSE or a SAVE through SAVE IN? pairs it with the net there, so a reload,
 * a load and the step forward never raise TOMB n, the save's high or the
 * wallet past the coins the walks take.
 */
function m26Leg(g, { need }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const t = g.world.tomb(0, 0), X = exitBoard(g.world);
  const gate = { x: X.x, y: X.y, cell: X.doors.find((dr) => dr.dir === t.exit).cell };
  const across = g.world.step(X, gate.cell, t.exit), into = { x: across.board.x, y: across.board.y, cell: across.cell };
  need(!X.entry, 'tomb (0, 0)\'s exit board is no entry at MEDIUM');
  const H = 1;
  // Before each PAUSE or SAVE IN?, the explorer stands on no entry, its net apart from the entry save point's.
  const offEntry = (h, what) => need(!h.sim.bd.entry && h.sim.here.net !== h.sim.entry.net, `M26 ${what}: the explorer stands on no entry, off the entry's net`);
  const holds = (h, wallet, what) => need(h.screen === 'play' && tombCount(h.sim) === H && saveNow(1).high === H
    && h.wallet === wallet && saveNow(1).wallet === wallet, `M26 ${what}`);
  // A clean run on A's exit board over slots `spec`, the free-slot rule armed.
  const start = (spec) => {
    fill(spec);
    openTitle(g);
    cleanState(g);
    g.armed = true;
    begin(g, X.p);
  };

  // Bound: the run takes slot 1, free, at the crossing into B, then three times steps back, PAUSEs, reloads,
  // loads the slot through LOAD and steps forward into B again.
  start('...');
  let coins = walkToCell(g, into, 'the walk into tomb B');
  need(g.screen === 'play' && tombCount(g.sim) === H && saveNow(1) !== null && saveNow(1).id === g.saveId, 'M26 the bound crossing into B takes slot 1 at TOMB 1');
  let wallet = g.wallet - coins, h = g;
  for (let loop = 1; loop <= 3; loop++) {
    coins += walkToCell(h, gate, 'the walk back into tomb A');
    offEntry(h, `bound loop ${loop}`);
    keyTo(h, 'KeyP', 'p');
    h = reload();
    loadSlot(h, 1);
    coins += walkToCell(h, into, 'the walk forward into tomb B');
    holds(h, wallet + coins, `bound loop ${loop}: TOMB n, the high and the wallet hold at H`);
  }

  // Unbound: slots 2 and 3 hold other saves, and another game fills slot 1 before the crossing, whose first
  // write then finds all three full, so the free-slot rule leaves the run unsaved. Each loop steps back,
  // pauses, saves to slot 1 through SAVE IN? and OVERWRITE SLOT 1?, reloads, loads the slot and steps forward
  // into B again. Another game then overwrites slot 1, so the loaded run's next write, at the step back,
  // finds its slot taken and, all three full, the rule leaves it unsaved again.
  start('.vv');
  putSave(1, { id: 'DDDDDDDD' });
  coins = walkToCell(g, into, 'the unbound walk into tomb B');
  need(g.screen === 'play' && tombCount(g.sim) === H && g.saveId === null, 'M26 the unbound crossing into B finds all three full and plays on unsaved');
  wallet = g.wallet - coins;
  h = g;
  for (let loop = 1; loop <= 3; loop++) {
    coins += walkToCell(h, gate, 'the walk back into tomb A');
    offEntry(h, `unbound loop ${loop}`);
    keyTo(h, 'KeyP', 'p');
    need(h.screen === 'pause' && h.saveId === null, `M26 unbound loop ${loop}: the pause is unsaved`);
    keyTo(h, 'Enter', 'Enter');
    need(h.screen === 'savein' && h.saveIn.rows[0].n === 1, `M26 unbound loop ${loop}: SAVE opens SAVE IN? on slot 1`);
    keyTo(h, 'Enter', 'Enter');
    keyTo(h, 'KeyY', 'y');
    need(h.screen === 'pause' && h.slot === 1 && saveNow(1) !== null && saveNow(1).id === h.saveId, `M26 unbound loop ${loop}: SAVE IN? binds the run to slot 1`);
    h = reload();
    loadSlot(h, 1);
    coins += walkToCell(h, into, 'the walk forward into tomb B');
    holds(h, wallet + coins, `unbound loop ${loop}: TOMB n, the high and the wallet hold at H`);
    putSave(1, { id: 'DDDDDDDD' });
  }
}

/**
 * M27K, the keyboard alone reaches the title, LOAD, code entry, the pick, both
 * confirms and the pause's SAVE IN?. Code entry takes every keydown, so a held
 * Backspace deletes once each, and the keyboard's P and Q type.
 */
function m27kLeg(g, { need, press }) {
  const rows = (keys) => keys.map((k) => { press(k, k); return g.row; }).join();
  fresh(g, 'v.v');
  press('ArrowDown', 'ArrowDown');
  press('ArrowDown', 'ArrowDown', true);
  need(g.cursor === LOAD_ROW, 'M27K Down moves the title\'s cursor to LOAD and stops there');
  press('ArrowUp', 'ArrowUp');
  need(g.cursor === BEGIN_ROW, 'M27K Up moves the title\'s cursor back to BEGIN');
  press('ArrowDown', 'ArrowDown');
  press('Enter', 'Enter');
  need(g.screen === 'load' && g.row === 2, 'M27K Enter on the lit LOAD opens LOAD, its cursor on the most recently played row');
  need(rows(['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']) === '1,0,0,1,2,3,3',
    'M27K LOAD\'s cursor visits every row, EMPTY included, and stops at the ends');
  press('Enter', 'Enter');
  need(g.typing === '', 'M27K Enter on T TYPE A CODE opens code entry');
  for (const [code, key] of [['KeyP', 'p'], ['KeyQ', 'q'], ['KeyK', 'k'], ['KeyL', 'l']]) press(code, key);
  need(g.screen === 'load' && g.typing === 'PQKL', 'M27K the keyboard\'s P and Q type into the code field');
  press('Backspace', 'Backspace');
  press('Backspace', 'Backspace', true);
  press('Backspace', 'Backspace', true);
  need(g.typing === 'P', 'M27K a repeated Backspace deletes once per keydown');
  press('Escape', 'Escape');
  need(g.screen === 'load' && g.typing === null, 'M27K Esc closes code entry to LOAD');
  press('KeyT', 't');
  press('Enter', 'Enter');
  need(g.screen === 'load' && g.typing === null, 'M27K Enter on an empty field closes it');
  press('Digit1', '1');
  need(g.screen === 'play' && g.slot === 1, 'M27K a digit on LOAD loads its slot');
  // The pick and its confirm, over three full slots.
  fill('vvv');
  press('KeyP', 'p');
  press('KeyQ', 'q');
  press('Enter', 'Enter');
  need(g.screen === 'pick', 'M27K Enter on BEGIN over three full slots opens the pick');
  need(rows(['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowDown']) === '0,0,0,1,2,2', 'M27K the pick\'s cursor visits every row and stops at the ends');
  press('Enter', 'Enter');
  need(g.confirm !== null && g.confirm.n === 3, 'M27K Enter on the pick asks OVERWRITE SLOT 3?');
  press('Escape', 'Escape');
  press('Digit2', '2');
  press('KeyN', 'n');
  need(g.screen === 'pick' && g.confirm === null, 'M27K Esc and N at OVERWRITE SLOT n? return to the pick');
  press('Digit2', '2');
  press('KeyQ', 'q');
  need(g.screen === 'title' && g.open !== null, 'M27K Q at OVERWRITE SLOT n? goes to the title');
  press('Enter', 'Enter');
  press('Digit2', '2');
  press('KeyY', 'y');
  need(g.screen === 'play' && g.mark !== null && g.mark.n === 2, 'M27K Y at OVERWRITE SLOT 2? marks slot 2');
  // The pause's SAVE IN? and its OVERWRITE SLOT n?.
  press('KeyP', 'p');
  press('Enter', 'Enter');
  press('ArrowDown', 'ArrowDown');
  press('Enter', 'Enter');
  need(g.screen === 'savein' && g.confirm !== null && g.confirm.n === 2, 'M27K Enter, Down and Enter on the unsaved pause ask OVERWRITE SLOT 2? on SAVE IN?');
  press('KeyN', 'n');
  press('Enter', 'Enter');
  press('KeyY', 'y');
  need(g.screen === 'pause' && g.slot === 2 && saveNow(2).id === g.saveId, 'M27K N, Enter and Y on SAVE IN? bind the run to slot 2');
  // LEAVE UNSAVED RUN?.
  openUnsaved(g);
  press('KeyT', 't');
  press('Digit1', '1');
  need(g.confirm !== null && g.confirm.kind === 'leave', 'M27K a digit on LOAD over an unsaved run asks LEAVE UNSAVED RUN?');
  press('KeyN', 'n');
  press('Digit1', '1');
  press('KeyY', 'y');
  need(g.screen === 'play' && g.slot === 1 && g.open === null, 'M27K N and Y answer LEAVE UNSAVED RUN?');
}

/**
 * M27T, touch's soft keys alone reach the title, LOAD, code entry, the pick,
 * both confirms and the pause's SAVE IN?. The BEGIN key begins wherever the
 * title's cursor stands.
 */
function m27tLeg(g, { need, click }) {
  const tap = (sid, which) => softTap(g, click, sid, which);
  fresh(g, 'v..');
  // The cursor on LOAD, as a keyboard beside the touch screen leaves it.
  g.cursor = LOAD_ROW;
  tap('title', 'begin');
  need(g.screen === 'play' && g.armed, 'M27T the BEGIN key begins with the cursor on LOAD');
  tap('play', 'pause');
  tap('pause', 'title');
  tap('title', 'load');
  need(g.screen === 'load', 'M27T the LOAD key opens LOAD');
  tap('load', 'back');
  need(g.screen === 'title', 'M27T BACK backs out of LOAD');
  tap('title', 'load');
  withPrompt(exitSerial(), () => tap('load', 'type'));
  need(g.screen === 'play' && hereCode(g) === exitSerial() && g.armed, 'M27T TYPE CODE takes a pasted save code');
  tap('play', 'pause');
  tap('pause', 'title');
  tap('title', 'load');
  tap('load', 's1');
  need(g.screen === 'play' && g.slot === 1, 'M27T SLOT 1 loads slot 1');
  // The pick and its confirm, over three full slots.
  fill('vvv');
  tap('play', 'pause');
  tap('pause', 'title');
  tap('title', 'begin');
  need(g.screen === 'pick', 'M27T BEGIN over three full slots opens the pick');
  tap('pick', 'back');
  need(g.screen === 'title', 'M27T BACK backs out of the pick');
  tap('title', 'begin');
  tap('pick', 's2');
  need(g.confirm !== null && g.confirm.n === 2, 'M27T SLOT 2 on the pick asks OVERWRITE SLOT 2?');
  tap('confirm', 'no');
  need(g.screen === 'pick' && g.confirm === null, 'M27T NO returns to the pick');
  tap('pick', 's2');
  tap('confirm', 'yes');
  need(g.screen === 'play' && g.mark !== null && g.mark.n === 2, 'M27T YES marks slot 2');
  // The pause's SAVE IN?.
  tap('play', 'pause');
  tap('pause', 'save');
  need(g.screen === 'savein' && g.saveIn.order === '123', 'M27T SAVE on the unsaved pause opens SAVE IN?');
  tap('savein', 'back');
  need(g.screen === 'pause', 'M27T BACK returns SAVE IN? to the pause');
  tap('pause', 'save');
  tap('savein', 's3');
  tap('confirm', 'no');
  need(g.screen === 'savein' && g.confirm === null, 'M27T NO at OVERWRITE SLOT 3? returns to SAVE IN?');
  tap('savein', 's3');
  tap('confirm', 'yes');
  need(g.screen === 'pause' && g.slot === 3 && saveNow(3).id === g.saveId, 'M27T YES on SAVE IN?\'s OVERWRITE SLOT 3? binds the run there');
  // LEAVE UNSAVED RUN?.
  openUnsaved(g);
  tap('title', 'load');
  tap('load', 's1');
  need(g.confirm !== null && g.confirm.kind === 'leave', 'M27T SLOT 1 over an unsaved run asks LEAVE UNSAVED RUN?');
  tap('confirm', 'no');
  tap('load', 's1');
  tap('confirm', 'yes');
  need(g.screen === 'play' && g.slot === 1 && g.open === null, 'M27T NO and YES answer LEAVE UNSAVED RUN?');
}

/**
 * M27C, a controller alone reaches the title, LOAD, code entry, the pick, both
 * confirms and the pause's SAVE IN?. A and Start answer no confirm, and Select
 * backs out of LOAD and the pick. In code entry Start types nothing, Select
 * closes the field, empty or not, and B on an empty field closes it.
 */
function m27cLeg(g, { need, fake }) {
  const tap = (...buttons) => {
    for (const b of buttons) {
      fake.held = new Set([b]);
      pollGamepads();
      fake.held = new Set();
      pollGamepads();
    }
  };
  const A = 0, B = 1, SELECT = 8, START = 9, UP = 12, DOWN = 13;
  fresh(g, 'v.v');
  tap(DOWN, B);
  need(g.screen === 'load', 'M27C Down and B open LOAD');
  tap(SELECT);
  need(g.screen === 'title', 'M27C Select backs out of LOAD');
  tap(DOWN, B, DOWN, B);
  need(g.screen === 'load' && g.typing === '', 'M27C Down and B on T TYPE A CODE open code entry');
  tap(START, A);
  need(g.screen === 'load' && g.typing === '', 'M27C Start and A type nothing in code entry');
  tap(B);
  need(g.screen === 'load' && g.typing === null, 'M27C B on an empty field closes code entry');
  tap(B);
  g.typing = 'K7';
  tap(SELECT);
  need(g.screen === 'load' && g.typing === null, 'M27C Select closes code entry holding a code');
  tap(B, SELECT);
  need(g.screen === 'load' && g.typing === null, 'M27C Select closes an empty code entry');
  tap(UP, B);
  need(g.screen === 'play' && g.slot === 3, 'M27C B on a LOAD row loads it');
  // The pick and its confirm, over three full slots.
  fill('vvv');
  tap(START, SELECT, B);
  need(g.screen === 'pick', 'M27C B on BEGIN over three full slots opens the pick');
  tap(SELECT);
  need(g.screen === 'title', 'M27C Select backs out of the pick');
  tap(B, B);
  const full = savesText();
  tap(A, START);
  need(g.screen === 'pick' && g.confirm !== null && savesText() === full, 'M27C A and Start answer nothing at OVERWRITE SLOT n?');
  tap(SELECT);
  need(g.screen === 'title' && g.confirm === null && savesText() === full, 'M27C Select answers no at OVERWRITE SLOT n?, to the title');
  tap(B, B, B);
  need(g.screen === 'play' && g.mark !== null, 'M27C B answers yes at OVERWRITE SLOT n?');
  // The pause's SAVE IN? and its OVERWRITE SLOT n?.
  tap(START, B, DOWN, B);
  need(g.screen === 'savein' && g.confirm !== null && g.confirm.n === 2, 'M27C Start, B, Down and B ask OVERWRITE SLOT 2? on SAVE IN?');
  tap(A, START);
  need(g.confirm !== null && g.saveId === null, 'M27C A and Start answer nothing on SAVE IN?\'s OVERWRITE SLOT 2?');
  tap(SELECT);
  need(g.screen === 'savein' && g.confirm === null, 'M27C Select answers no on SAVE IN?\'s OVERWRITE SLOT 2?');
  tap(B, B);
  need(g.screen === 'pause' && g.slot === 2 && saveNow(2).id === g.saveId, 'M27C B and B bind the run to slot 2 through SAVE IN?');
  // LEAVE UNSAVED RUN?.
  openUnsaved(g);
  tap(DOWN, B, B);
  need(g.confirm !== null && g.confirm.kind === 'leave', 'M27C B on a LOAD row over an unsaved run asks LEAVE UNSAVED RUN?');
  tap(A, START);
  need(g.confirm !== null && g.confirm.kind === 'leave', 'M27C A and Start answer nothing at LEAVE UNSAVED RUN?');
  tap(SELECT);
  need(g.screen === 'load' && g.confirm === null && g.open !== null, 'M27C Select answers no at LEAVE UNSAVED RUN?');
  tap(B, B);
  need(g.screen === 'play' && g.open === null && g.slot !== null, 'M27C B answers yes at LEAVE UNSAVED RUN?');
  g.press = 0;
  g.release = 0;
  g.jump = false;
}

// The touch leg's legs in order: the revision 1 legs, then the matrix's.
const LEGS = [
  difficultyLeg, coinLeg, twoGamesLeg, splashLeg, resumeLeg, continueLeg, legacyLeg, oilLeg, gamepadLeg,
  m8Leg, m19Leg, m11Leg, m1Leg, m2Leg, m10Leg, m6Leg, m7Leg, m22Leg, m21Leg, m3Leg, m5Leg, m4Leg, m9Leg,
  m12Leg, m13Leg, m14Leg, m15Leg, m16Leg, m17Leg, m18Leg, m20Leg, m24Leg, m26Leg, m27kLeg, m27tLeg, m27cLeg,
];

const DIRS = {
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
};
const DIR_BITS = { l: KEY.L, r: KEY.R, u: KEY.U, d: KEY.D };
const JUMP_KEYS = ['Space', 'KeyZ'];
// The title's keys that step the difficulty setting, stopping at the ends.
const SETTING_STEP = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
// The digit keys of the three slot rows.
const SLOT_DIGITS = { Digit1: 1, Digit2: 2, Digit3: 3 };
// The title cursor's two rows, and LOAD's fourth row, T TYPE A CODE, after its three slots.
const BEGIN_ROW = 0, LOAD_ROW = 1, TYPE_ROW = 3;

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

/** The economy of a new run: no slot, no mark, the free-slot rule unarmed and wallet 0. */
function cleanState(g) {
  Object.assign(g, { slot: null, saveId: null, point: null, wallet: 0, mark: null, armed: false });
}

/** The fields of the game's economy, which a run left open takes with it. */
function economyOf(g) {
  const { slot, saveId, point, wallet, mark, armed } = g;
  return { slot, saveId, point, wallet, mark, armed };
}

/**
 * A tick's one write and its pay: the tick took `coins`, the high rose from
 * `was`, `entered` an entry board and `moved` changed tomb or took a jar. A run
 * holding a save writes on any of them: an entry moves the serial to the entry
 * save point, and the rest keep it. A run holding none claims a slot at its
 * coin or counted tomb, at the entry save point. Returns the pay, { earned,
 * seen }, or null when the tick earned nothing.
 */
function tickSave(g, coins, was, entered, moved) {
  const s = g.sim, earns = coins > 0 || tombCount(s) > was;
  let out = null;
  if (g.saveId !== null) {
    if (entered) out = writeAt(g, s.entry, { coins, was });
    else if (earns || moved) out = commit(g, g.point, { coins, was });
  } else if (earns) {
    out = claim(g, pointOf(g, s.entry), { coins, was });
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
    // A game starts clean: no slot, no save and wallet 0. A run takes slot
    // `slot` under `saveId` and writes its serial and net at `point`. A run
    // holding none is marked for slot n, `mark` { n, id }, which its first
    // coin or counted tomb overwrites while it holds `id`; or `armed`, its
    // first coin or counted tomb taking the lowest free slot; or neither.
    slot: null, saveId: null, point: null, wallet: 0, mark: null, armed: false,
    // The title cursor's row, BEGIN_ROW or LOAD_ROW, and the LOAD and pick cursor's, 0 to TYPE_ROW.
    cursor: BEGIN_ROW, row: 0,
    // The run BEGIN's rules hold while the overwrite pick shows: { code, p }.
    pick: null,
    // A confirm on the title, LOAD or the pick: { kind: 'leave', go } or
    // { kind: 'overwrite', n, held }, slot n as drawn; on SAVE IN? the
    // overwrite alone; null when none is asked.
    confirm: null,
    // The pause's SAVE IN?: { at, rows, cursor, order } while it shows.
    saveIn: null,
    // The coins the wallet has gained since the run began; Continue carries them.
    earned: 0,
    // The note play shows for its ticks: its text and ink.
    noteText: '', noteInk: 'm', noteTicks: 0,
    audio: createAudio(), keys: new Set(), cam: { x: 0, y: 0 },
    // Key edges since the last tick: KEY bits pressed and released, and a jump press.
    press: 0, release: 0, jump: false,
    code: firstSeed(),
    // The side of the d-pad: 'left' or 'right'.
    side: padSide(load(KEY_PAD)),
    // The title's setting; `world` is always built at it.
    difficulty: storedDifficulty(KEY_DIFFICULTY, 'medium'),
    world: null, renderer: null, sim: null, preview: null,
    // The run left for the title by Q: its economy, code, world, renderer, preview and sim.
    open: null,
    // The milestone the splash shows: { k, paid }, where paid is whether this crossing paid.
    splash: null,
    typing: null, note: '', footFrame: -1, climbFrame: -1,
    // The tomb { u, v } the pause map frames, and its model.
    frame: { u: 0, v: 0 }, pauseMap: null, pausedAt: null,
  };
}

/** The seed the title shows at boot: the most recently played valid slot's, else a rolled one. */
function firstSeed() {
  const n = playedSlot(SAVE_SLOTS.map(heldSave), true);
  return n === null ? rollCode() : decodeSave(heldSave(n).record.save).code;
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
 * Starts a run at save position p, or at tomb (0, 0)'s first entry when p is
 * null, with no note. The new sim keeps the coins and jars taken in the tomb
 * it starts in and the tomb before it only when the `carry` holds them: the
 * end screen's Continue carries them and a load of a save unpacks them. Any
 * other start takes none, and every coin and jar lies back.
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
  g.pick = null;
  g.noteTicks = 0;
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

/**
 * BEGIN's rules for a new run of seed `code` from save position p, null for
 * tomb (0, 0)'s first entry. Over an open run unsaved with progress it asks
 * LEAVE UNSAVED RUN? first, unless `asked`. With a slot free, or none
 * writable, the run starts with the free-slot rule armed; with all three full
 * the overwrite pick asks first, and the open run stays open until the pick's
 * yes.
 */
function beginRules(g, start, asked = false) {
  if (!asked && leaving(g)) g.confirm = { kind: 'leave', go: () => beginRules(g, start, true) };
  else if (!writable() || freeSlot() !== undefined) startRun(g, start, { armed: true });
  else openPick(g, start);
}

/** BEGIN: a run of the shown seed from tomb (0, 0), under BEGIN's rules. */
function beginNew(g) {
  beginRules(g, { code: g.code, p: null });
}

/** Starts a new run of `start` with a clean economy and `claim`, its mark or the armed rule, closing any open run. */
function startRun(g, start, claim) {
  cleanState(g);
  Object.assign(g, claim);
  if (start.code !== g.code) useCode(g, start.code);
  begin(g, start.p);
}

/**
 * Loads slot n's record `rec` into memory and begins its run at the serial's
 * board, at the record's difficulty, with its start tomb, net, high, wallet,
 * continue count and recent takes, closing any open run. The run is bound to
 * slot n under the record's id, and writes nothing until its next save point.
 * The setting follows.
 */
function restore(g, n, rec) {
  const at = decodeSave(rec.save);
  keepSetting(g, rec.level);
  if (at.code !== g.code || g.world.difficulty !== rec.level) useCode(g, at.code);
  Object.assign(g, { slot: n, saveId: rec.id, point: { save: rec.save, net: rec.net, start: rec.start }, wallet: rec.wallet, mark: null, armed: false });
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

/** P, Esc and Start on the title: back to the open run; with none open, nothing. */
function resume(g) {
  if (g.open) resumeOpen(g);
}

/**
 * True when the open run is unsaved with progress: it holds no slot, and its
 * wallet or high is above 0. A run bound to a slot that no longer holds its id
 * holds none.
 */
function leaving(g) {
  const o = g.open;
  if (!o || (o.wallet <= 0 && tombCount(o.sim) <= 0)) return false;
  if (o.saveId === null) return true;
  const held = heldSave(o.slot);
  return held.state !== 'valid' || held.record.id !== o.saveId;
}

/** True when `held` is the open run's own row: a valid record under the open run's id. */
function ownRow(g, held) {
  return g.open !== null && g.open.saveId !== null && held.state === 'valid' && held.record.id === g.open.saveId;
}

/**
 * Enter, a digit or a SLOT key on LOAD's row n, read now: the open run's own
 * row resumes it; another valid row loads at once, after LEAVE UNSAVED RUN?
 * over an open run unsaved with progress, unless `asked`; EMPTY, DAMAGED and
 * NEWER rows do nothing.
 */
function loadRow(g, n, asked = false) {
  const held = heldSave(n);
  if (held.state !== 'valid') return;
  if (ownRow(g, held)) resumeOpen(g);
  else if (!asked && leaving(g)) g.confirm = { kind: 'leave', go: () => loadRow(g, n, true) };
  else restore(g, n, held.record);
}

/** Opens LOAD, its cursor on the open run's own row, else the most recently played valid row, else T TYPE A CODE. */
function openLoad(g) {
  Object.assign(g, { typing: null, note: '', confirm: null, row: TYPE_ROW });
  const helds = SAVE_SLOTS.map(heldSave), own = helds.findIndex((held) => ownRow(g, held));
  const latest = playedSlot(helds, true);
  if (own >= 0) g.row = own;
  else if (latest !== null) g.row = latest - 1;
  g.screen = 'load';
}

/** Opens the overwrite pick for the run `start`, its cursor on the least recently played valid row. */
function openPick(g, start) {
  g.pick = start;
  g.confirm = null;
  g.row = (playedSlot(SAVE_SLOTS.map(heldSave), false) || 1) - 1;
  g.screen = 'pick';
}

/** The pick's row n, read now: a valid record asks OVERWRITE SLOT n?; any other row does nothing. */
function pickRow(g, n) {
  const held = heldSave(n);
  if (held.state === 'valid') g.confirm = { kind: 'overwrite', n, held };
}

/**
 * The pick's OVERWRITE SLOT n? yes re-reads slot n: the record drawn starts
 * the run marked for slot n under that id; another valid record redraws the
 * confirm; an empty, damaged or newer slot reruns BEGIN's rules, which ask no
 * second LEAVE UNSAVED RUN?.
 */
function overwriteYes(g, c) {
  const held = heldSave(c.n);
  if (held.state === 'valid' && held.record.id === c.held.record.id) startRun(g, g.pick, { mark: { n: c.n, id: held.record.id } });
  else if (held.state === 'valid') g.confirm = { ...c, held };
  else {
    g.confirm = null;
    beginRules(g, g.pick, true);
  }
}

/**
 * Answers LEAVE UNSAVED RUN? and the pick's OVERWRITE SLOT n?: Y and Enter are
 * yes. N and Esc are no, back to the screen that asked, and so is Q, which on
 * the pick's confirm goes to the title. Nothing else answers, and no repeat.
 */
function confirmKey(g, e) {
  if (e.repeat) return;
  const c = g.confirm;
  if (e.code === 'KeyY' || e.key === 'Enter') {
    if (c.kind === 'leave') {
      g.confirm = null;
      c.go();
    } else overwriteYes(g, c);
  } else if (e.code === 'KeyN' || e.key === 'Escape') g.confirm = null;
  else if (e.code === 'KeyQ') {
    if (c.kind === 'overwrite') toTitle(g);
    else g.confirm = null;
  }
}

function hereCode(g) {
  return encodeSave(g.code, g.sim.bd.x, g.sim.bd.y);
}

function entryCode(g) {
  const { x, y } = boardOfPos(g.sim.lastEntry);
  return encodeSave(g.code, x, y);
}

/**
 * LOAD's typed answer: a valid slot's serial acts as Enter on the first such
 * row; the open run's serial resumes it; any other save code starts a run at
 * its board, at the setting, under BEGIN's rules; a seed becomes the title's
 * shown seed and LOAD returns to the title; anything else reads NOT A SEED OR
 * SAVE CODE.
 */
function submitTyped(g) {
  const save = decodeSave(g.typing);
  if (save) {
    g.typing = null;
    // A code carries no count or coins: only a slot's own serial loads its save.
    const n = SAVE_SLOTS.find((k) => {
      const held = heldSave(k), kept = held.state === 'valid' && decodeSave(held.record.save);
      return kept && kept.code === save.code && kept.p === save.p;
    });
    if (n !== undefined) loadRow(g, n);
    else if (g.open && g.open.code === save.code && g.open.sim.bd.p === save.p) resumeOpen(g);
    else beginRules(g, { code: save.code, p: save.p });
    return;
  }
  const c = parseCode(g.typing);
  if (c) {
    useCode(g, c);
    toTitle(g);
    g.note = '';
    return;
  }
  g.note = 'NOT A SEED OR SAVE CODE';
}

// Set while pollGamepads dispatches a controller's key, so code entry tells a
// pad's Select and Start from the keyboard's Q and P.
let fromPad = false;

/**
 * Code entry on LOAD: Enter submits, or closes an empty field; Esc and a pad's
 * Select close it; a pad's Start types nothing; Backspace deletes, repeats
 * included; letters, digits, '-' and ':' type, the keyboard's P and Q too.
 */
function typingKey(g, e) {
  if (fromPad && e.code === 'KeyP') return;
  if (e.key === 'Escape' || (fromPad && e.code === 'KeyQ') || (e.key === 'Enter' && g.typing === '')) { g.typing = null; g.note = ''; }
  else if (e.key === 'Enter') submitTyped(g);
  else if (e.key === 'Backspace') g.typing = g.typing.slice(0, -1);
  else if (/^[0-9A-Za-z:\-]$/.test(e.key) && g.typing.length < TYPED_MAX) g.typing += e.key.toUpperCase();
}

/** Whether the screen visit now showing is still on; true until `g.screen` is written. */
function visitLive(g) {
  const visit = g.visit;
  return () => g.visit === visit;
}

/**
 * The title: Up and Down move the cursor between BEGIN and LOAD; Enter acts
 * on the lit row; Space begins and T opens LOAD wherever it stands. P resumes
 * an open run. R rolls a seed, K copies it, L and Left and Right step the
 * setting and H swaps the pad's side. Every repeat but the arrows' does
 * nothing.
 */
function titleKey(g, e) {
  if (g.confirm) { confirmKey(g, e); return; }
  const dir = DIRS[e.code], at = DIFFICULTIES.indexOf(g.difficulty);
  if (dir === 'u' || dir === 'd') g.cursor = dir === 'd' ? LOAD_ROW : BEGIN_ROW;
  else if (SETTING_STEP[e.code]) {
    setDifficulty(g, DIFFICULTIES[Math.max(0, Math.min(DIFFICULTIES.length - 1, at + SETTING_STEP[e.code]))]);
  } else if (e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }
  else if (e.code === 'KeyH') {
    if (!e.repeat) {
      g.side = g.side === 'left' ? 'right' : 'left';
      store(KEY_PAD, g.side);
    }
  } else if (e.repeat) return;
  else if (e.key === 'Enter') { if (g.cursor === LOAD_ROW) openLoad(g); else beginNew(g); }
  else if (e.code === 'Space') beginNew(g);
  else if (e.code === 'KeyT') openLoad(g);
  else if (e.code === 'KeyR') { useCode(g, rollCode()); g.note = ''; }
  else if (e.code === 'KeyL') setDifficulty(g, DIFFICULTIES[(at + 1) % DIFFICULTIES.length]);
  else if (e.code === 'KeyK') {
    copyWithStatus(globalThis.navigator.clipboard, formatCode(g.code), (status) => { g.note = status; }, visitLive(g));
  }
}

/**
 * LOAD: Up and Down move the cursor over the three slot rows and T TYPE A
 * CODE, stopping at the ends; Enter acts on the lit row, a digit on its slot's
 * row and T opens code entry; Q and Esc go back to the title. Every repeat but
 * the arrows' does nothing.
 */
function loadKey(g, e) {
  if (g.confirm) { confirmKey(g, e); return; }
  if (g.typing !== null) { typingKey(g, e); return; }
  const dir = DIRS[e.code];
  if (dir === 'u' || dir === 'd') g.row = Math.max(0, Math.min(TYPE_ROW, g.row + (dir === 'd' ? 1 : -1)));
  else if (e.repeat) return;
  else if (e.key === 'Enter') { if (g.row === TYPE_ROW) { g.typing = ''; g.note = ''; } else loadRow(g, g.row + 1); }
  else if (SLOT_DIGITS[e.code]) loadRow(g, SLOT_DIGITS[e.code]);
  else if (e.code === 'KeyT') { g.typing = ''; g.note = ''; }
  else if (e.code === 'KeyQ' || e.key === 'Escape') toTitle(g);
}

/**
 * OVERWRITE WHICH SLOT?: Up and Down move the cursor over the three rows,
 * stopping at the ends; Enter and a digit pick a row; Q and Esc go back to the
 * title. Every repeat but the arrows' does nothing.
 */
function pickKey(g, e) {
  if (g.confirm) { confirmKey(g, e); return; }
  const dir = DIRS[e.code];
  if (dir === 'u' || dir === 'd') g.row = Math.max(0, Math.min(SAVE_SLOTS.length - 1, g.row + (dir === 'd' ? 1 : -1)));
  else if (e.repeat) return;
  else if (e.key === 'Enter') pickRow(g, g.row + 1);
  else if (SLOT_DIGITS[e.code]) pickRow(g, SLOT_DIGITS[e.code]);
  else if (e.code === 'KeyQ' || e.key === 'Escape') toTitle(g);
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

/** Shows the title from another screen, its cursor on BEGIN. */
function toTitle(g) {
  Object.assign(g, { cursor: BEGIN_ROW, confirm: null, typing: null, pick: null });
  g.screen = 'title';
  titleCam(g);
}

/** Goes to the title with the run open: P there returns to it unchanged. */
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

/** True while the pause offers SAVE: the run holds no slot and a slot is writable, so SAVE IN? lists a row. */
const saveOffered = (g) => g.saveId === null && writable();

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

/** Lists SAVE IN?'s rows from storage, the cursor on the first, and returns how many it lists. */
function listSaveIn(si) {
  const rows = saveInRows();
  Object.assign(si, { rows, cursor: 0, order: rows.map((r) => r.n).join('') });
  return rows.length;
}

/** Opens SAVE IN? on the pause, which binds the run at save point `at` to the slot the player picks, while SAVE shows. */
function openSaveIn(g, at) {
  if (!saveOffered(g)) return;
  const si = { at };
  if (!listSaveIn(si)) return;
  g.saveIn = si;
  g.screen = 'savein';
}

/** Returns from SAVE IN? to the pause. */
function closeSaveIn(g) {
  g.saveIn = null;
  g.confirm = null;
  g.screen = 'pause';
}

/** Redraws SAVE IN?'s rows from storage; with none left, back to the pause. */
function redrawSaveIn(g) {
  if (!listSaveIn(g.saveIn)) closeSaveIn(g);
}

/** Whether a slot's state `now` differs from the one a confirm drew: emptied, filled or under another id. */
function changed(drawn, now) {
  if (isFree(drawn)) return !isFree(now);
  return now.state !== 'valid' || now.record.id !== drawn.record.id;
}

/**
 * Picks SAVE IN?'s row: a slot that changed since it was drawn redraws the
 * rows; an empty or damaged one binds the run there and writes it, dropping
 * any mark; a used one asks OVERWRITE SLOT n?.
 */
function saveRow(g, row) {
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
  if (take(g, row.n, pointOf(g, g.saveIn.at)).ok) closeSaveIn(g);
  else redrawSaveIn(g);
}

/**
 * SAVE IN?'s OVERWRITE SLOT n? yes binds the run there under a fresh id while
 * the slot holds the record drawn. A record under another id redraws the
 * confirm; an emptied or newer slot returns to SAVE IN?.
 */
function saveInYes(g) {
  const c = g.confirm;
  const out = take(g, c.n, pointOf(g, g.saveIn.at), { over: c.held.record.id });
  if (out.ok) closeSaveIn(g);
  else if (out.held.state === 'valid') g.confirm = { ...c, held: out.held };
  else {
    g.confirm = null;
    redrawSaveIn(g);
  }
}

/**
 * SAVE IN?: Up and Down move the cursor over its rows, and Enter or a listed
 * slot's digit picks; Q and Esc return to the pause. OVERWRITE SLOT n? takes Y
 * and Enter for yes and N, Q and Esc for no, back to SAVE IN?. Both ignore
 * Space, P and every repeated key.
 */
function saveInKey(g, e) {
  if (e.repeat) return;
  const si = g.saveIn;
  if (g.confirm) {
    if (e.code === 'KeyY' || e.key === 'Enter') saveInYes(g);
    else if (e.code === 'KeyN' || e.code === 'KeyQ' || e.key === 'Escape') g.confirm = null;
    return;
  }
  const dir = DIRS[e.code];
  if (dir === 'u' || dir === 'd') si.cursor = Math.max(0, Math.min(si.rows.length - 1, si.cursor + (dir === 'd' ? 1 : -1)));
  else if (e.key === 'Enter') saveRow(g, si.rows[si.cursor]);
  else if (SLOT_DIGITS[e.code]) saveRow(g, si.rows.find((r) => r.n === SLOT_DIGITS[e.code]));
  else if (e.code === 'KeyQ' || e.key === 'Escape') closeSaveIn(g);
}

const SCREEN_KEYS = {
  title: titleKey, load: loadKey, pick: pickKey, play: playKey, savein: saveInKey, pause: pauseKey, over: overKey, splash: splashKey,
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
  // The note counts ticks of play alone, so a pause or a splash holds it.
  if (g.noteTicks > 0) g.noteTicks--;
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
  // A run that ends on the milestone's tick shows the end screen; the payout stands.
  if (g.sim.state === 'over') endRun(g);
  else if (hit) showSplash(g, hit.k, hit.paid);
}

/** The best tomb the title shows: the shown seed's, at the setting. */
function titleBest(g) {
  return readBest(g.code, g.difficulty);
}

/** The title's warning line: SAVES OFF while the latest store failed, else a newer game's saves while all three read NEWER. */
function titleWarning() {
  if (storage.failed()) return 'SAVES OFF: COPY YOUR CODE';
  return allNewer() ? 'SAVES FROM A NEWER GAME: RELOAD' : '';
}

/** The backdrop of the title, LOAD and the pick: the preview explorer under a veil, the warning line and the game's name. */
function titleScene(g, t) {
  const r = g.renderer, warning = titleWarning();
  r.scene(g.preview, g.cam, t);
  r.ctx.fillStyle = shade(0.45);
  r.ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  if (warning) r.text(warning, VIEW_W / 2, 4, 'o', { align: 'center' });
  r.text('INFINITE MAZE', VIEW_W / 2, 18, 'm', { align: 'center', scale: 2 });
}

/** The note line and the controls line under the title's, LOAD's and the pick's panels. */
function titleFooter(g) {
  const r = g.renderer;
  if (g.note) r.text(g.note, VIEW_W / 2, 152, 'o', { align: 'center' });
  r.text(touch && touch.on ? 'D-PAD MOVE  RED BUTTON JUMP' : 'ARROWS/WASD MOVE  SPACE/Z JUMP  M MUTE  P PAUSE', VIEW_W / 2, 166, '9', { align: 'center' });
}

/** The cursor's bar behind the row at y: x to x + w, h px tall from y - 2, edged gold on the left. */
function bar(r, x, y, w, h = 11) {
  r.ctx.fillStyle = PALETTE[3];
  r.ctx.fillRect(x, y - 2, w, h);
  r.ctx.fillStyle = PALETTE[0x16];
  r.ctx.fillRect(x, y - 2, 2, h);
}

let coinSprite = null;

/** A save's level, TOMB n (its high) and the coin sprite before the wallet, which ends at x 248, on the row at y. */
function recordLine(r, level, high, wallet, y, ink) {
  const count = String(wallet);
  r.text(difficultyLabel(level), 84, y, ink);
  r.text(`TOMB ${high}`, 138, y, ink);
  r.text(count, 248, y, ink, { align: 'right' });
  coinSprite = coinSprite || spriteCanvas(COIN);
  r.ctx.drawImage(coinSprite, 248 - textWidth(count) - 2 * (FONT_W + 1), y);
}

/**
 * Slot n's row at y: its number, then EMPTY, DAMAGED or NEWER, or the
 * record's level, TOMB n and coins. With `now`, the row takes a second line,
 * the time since the record was played, and its cursor's bar spans both. A
 * lit row stands on the cursor's bar.
 */
function slotRow(g, held, n, y, lit, { num = true, now = null } = {}) {
  const r = g.renderer, ink = lit ? 'm' : 'b';
  if (lit) bar(r, 65, y, 190, now === null ? 11 : 20);
  if (num) r.text(String(n), 72, y, ink);
  if (held.state !== 'valid') {
    r.text(ROW_LABEL[held.state], 84, y, lit ? 'm' : held.state === 'damaged' ? 'o' : '7');
    return;
  }
  const { level, high, wallet, played } = held.record;
  recordLine(r, level, high, wallet, y, ink);
  if (now !== null) r.text(playedLabel(played, now), 84, y + 9, lit ? 'm' : '9');
}

/**
 * The title: SEED, ENTER BEGIN, the difficulty row, R RESET and K COPY,
 * T LOAD and the best tomb, the cursor's bar behind BEGIN or LOAD; or the
 * LEAVE UNSAVED RUN? it asks.
 */
function drawTitle(g, t) {
  titleScene(g, t);
  const r = g.renderer, best = titleBest(g), begins = g.cursor === BEGIN_ROW;
  if (g.confirm) drawConfirm(g);
  else {
    r.text('A TOMB WITHOUT END', VIEW_W / 2, 38, 'a', { align: 'center' });
    r.panel(62, 50, 196, 88);
    r.text(`SEED  ${formatCode(g.code)}`, VIEW_W / 2, 58, 'i', { align: 'center' });
    bar(r, 65, begins ? 74 : 110, 190);
    r.text('ENTER  BEGIN', 72, 74, begins ? 'm' : 'c');
    drawSettingRow(g, 86);
    r.text('R      RESET', 72, 98, 'b');
    r.text('K COPY', 248, 98, 'b', { align: 'right' });
    r.text('T      LOAD', 72, 110, begins ? 'b' : 'm');
    r.text(best === null ? 'THE MOUTH OF THE TOMB' : `BEST TOMB  ${best}`, VIEW_W / 2, 124, 'p', { align: 'center' });
  }
  titleFooter(g);
}

// LOAD's and the pick's slot rows stand 20 px apart from y 58, each on two lines.
const ROWS_Y = [58, 78, 98];

/** LOAD: the three slot rows, T TYPE A CODE and the hint; the code field while typing; or the confirm it asks. */
function drawLoad(g, t) {
  titleScene(g, t);
  const r = g.renderer, touchOn = touch && touch.on, now = Date.now();
  if (g.confirm) drawConfirm(g);
  else {
    r.panel(62, 36, 196, touchOn ? 98 : 112);
    r.text('LOAD', VIEW_W / 2, 44, 'i', { align: 'center' });
    if (g.typing !== null) {
      // No label, so TYPED_MAX characters and the cursor fit the panel.
      r.text(`${g.typing}${Math.floor(t * 2) % 2 ? '_' : ' '}`, 72, 58, 'c');
      r.text('ENTER  ACCEPT', 72, 72, 'b');
      r.text('ESC    CANCEL', 72, 84, 'b');
      r.text('SEED  XXXX-XXXX', 72, 98, '9');
      r.text('SAVE  XXXX-XXXX:P', 72, 110, '9');
    } else {
      for (const n of SAVE_SLOTS) slotRow(g, heldSave(n), n, ROWS_Y[n - 1], g.row === n - 1, { now });
      const lit = g.row === TYPE_ROW;
      if (lit) bar(r, 65, 120, 190);
      r.text('T', 72, 120, lit ? 'm' : 'b');
      r.text('TYPE A CODE', 84, 120, lit ? 'm' : 'i');
      if (!touchOn) r.text('ENTER LOAD  Q BACK', VIEW_W / 2, 134, 'p', { align: 'center' });
    }
  }
  titleFooter(g);
}

/** OVERWRITE WHICH SLOT?: the three slot rows and the hint, or the OVERWRITE SLOT n? it asks. */
function drawPick(g, t) {
  titleScene(g, t);
  const r = g.renderer, touchOn = touch && touch.on, now = Date.now();
  if (g.confirm) drawConfirm(g);
  else {
    r.panel(62, 36, 196, touchOn ? 84 : 98);
    r.text('OVERWRITE WHICH SLOT?', VIEW_W / 2, 44, 'o', { align: 'center' });
    for (const n of SAVE_SLOTS) slotRow(g, heldSave(n), n, ROWS_Y[n - 1], g.row === n - 1, { now });
    if (!touchOn) r.text('ENTER PICK  Q BACK', VIEW_W / 2, 120, 'p', { align: 'center' });
  }
  titleFooter(g);
}

/** LEAVE UNSAVED RUN?, naming the open run's level, TOMB n and coins, or the pick's OVERWRITE SLOT n? with the row as drawn and its time. */
function drawConfirm(g) {
  const r = g.renderer, c = g.confirm, touchOn = touch && touch.on;
  r.panel(62, 36, 196, touchOn ? 44 : 58);
  if (c.kind === 'leave') {
    const o = g.open;
    r.text('LEAVE UNSAVED RUN?', VIEW_W / 2, 44, 'o', { align: 'center' });
    recordLine(r, o.world.difficulty, tombCount(o.sim), o.wallet, 60, 'b');
  } else {
    r.text(`OVERWRITE SLOT ${c.n}?`, VIEW_W / 2, 44, 'o', { align: 'center' });
    slotRow(g, c.held, c.n, 60, false, { num: false, now: Date.now() });
  }
  if (!touchOn) r.text('Y YES  N NO', VIEW_W / 2, 82, 'p', { align: 'center' });
}

/**
 * The title's setting row at y: all four names after L, the current one lit.
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

/** SAVE IN? over the paused run, rows 14 px apart from y 72, or the OVERWRITE SLOT n? it asks. */
function drawSaveIn(g) {
  const r = g.renderer, touchOn = touch && touch.on, si = g.saveIn;
  if (g.confirm) {
    const { n, held } = g.confirm;
    r.panel(62, 60, 196, touchOn ? 40 : 54);
    r.text(`OVERWRITE SLOT ${n}?`, VIEW_W / 2, 68, 'o', { align: 'center' });
    slotRow(g, held, n, 84, false, { num: false });
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
// apart. A run holding no slot pauses UNSAVED where SAVE CODE stands, and
// Enter there saves while SAVE shows.
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
    if (saveOffered(g)) {
      r.text('ENTER SAVE  P RESUME  Q TITLE', VIEW_W / 2, 145, 'b', { align: 'center' });
      r.text('C COPY  M MUTE  ARROWS PAN', VIEW_W / 2, 156, 'b', { align: 'center' });
    } else {
      r.text('P RESUME  ARROWS PAN  Q TITLE', VIEW_W / 2, 145, 'b', { align: 'center' });
      r.text('M MUTE  C COPY', VIEW_W / 2, 156, 'b', { align: 'center' });
    }
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

// The note stands centred under the HUD's top line, clear of the torch bar,
// EMBER and the wallet and far above the explorer, whom the camera keeps near
// the view's middle. Its text is built when the note is set, so a frame
// builds nothing for it.
const NOTE_Y = 14;
const NOTE_AT = { align: 'center' };

function draw(g, t) {
  if (g.screen === 'title') drawTitle(g, t);
  else if (g.screen === 'load') drawLoad(g, t);
  else if (g.screen === 'pick') drawPick(g, t);
  else {
    g.renderer.scene(g.sim, g.cam, t);
    g.renderer.hud(g.sim, g.wallet);
    if (g.screen === 'play') { if (g.noteTicks > 0) g.renderer.text(g.noteText, VIEW_W / 2, NOTE_Y, g.noteInk, NOTE_AT); }
    else if (g.screen === 'pause') drawPause(g, t);
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

/** Sends the key events the gamepads have due, as the keyboard would, marked as a pad's while they dispatch. */
function pollGamepads() {
  for (const o of gamepad.poll()) {
    fromPad = true;
    try {
      window.dispatchEvent(new KeyboardEvent(o.type, { code: o.code, key: o.key, repeat: false, bubbles: true, cancelable: true }));
    } finally {
      fromPad = false;
    }
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
    if ((g.screen === 'title' || g.screen === 'load' || g.screen === 'pick') && g.preview) titleCam(g);
  };
  // `touch.refresh` reads this every frame; in play it reads no storage.
  touch = createTouch({
    state: () => ({
      screen: g.screen, typing: g.typing !== null, confirm: g.confirm !== null, muted: g.audio.muted, difficulty: g.difficulty, side: g.side,
      resume: g.screen === 'title' && g.open !== null, save: g.screen === 'pause' && saveOffered(g),
      rows: g.screen === 'savein' ? g.saveIn.order : '',
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
