// Boot, input, the fixed 60 Hz loop and the title, play, pause, end and
// milestone splash screens. `#selftest` in the URL runs the self-test instead.
import { createWorld, boardOfPos, boardCoords } from '../world/world.mjs';
import { DIFFICULTY, DIFFICULTIES } from '../world/band.mjs';
import { parseCode, formatCode, codeFromBytes } from '../world/hash.mjs';
import { encodeSave, decodeSave } from '../world/save.mjs';
import { floorItems, itemSpot, coinRows, rowSpot } from '../world/floor.mjs';
import {
  createSim, step, runCarry, TICK, BURN_S, KEY, feet, pose, nodeXY, tombCount, inputEdges, createTrail,
} from './sim.mjs';
import { snapCam, followCam, createFrame, placeFrame, deviceX, deviceY } from './camera.mjs';
import { createRenderer, VIEW_W, VIEW_H, MAP_SCALE, shade } from './render.mjs';
import { createAudio } from './audio.mjs';
import { runScript, createAutopilot, SELFTEST_CODE } from './autopilot.mjs';
import {
  SLOT_KEY, LEGACY_KEYS, COIN_RATE, coinKey, coinId, coinPay, tombPay, commitSlot, parseSlot, serializeSlot, legacySlot, newSlotId,
  packRecent, unpackRecent,
} from './wallet.mjs';
import { createGamepad } from './gamepad.mjs';
import { createTouch, layout, viewport, difficultyLabel, padSide, titleFeet, PANEL_X, textWidth } from './touch.mjs';
import { MILESTONE, rankName } from './ranks.mjs';
import { copyWithStatus, saveLabel } from './clipboard.mjs';
import { createGuard, errorLine } from './loop.mjs';
import { createStorage } from './storage.mjs';
import { frameOf, panFrame, sameFrame, mapModel, mapCells } from './map.mjs';
import { RGB, idx } from './art.mjs';

// The bests of the tomb plane keep a key of their own, so a stacked-world value
// never reads as a score. The save slot lives under SLOT_KEY (wallet.mjs).
// The title's difficulty setting; absent means MEDIUM.
const KEY_DIFFICULTY = 'infinite-maze.difficulty';
// The d-pad's side, 'left' or 'right'; anything else reads 'left'.
const KEY_PAD = 'infinite-maze.pad';
const KEY_BEST = 'infinite-maze.plane.best';
// A save code runs to 26 characters: 10 for the seed and up to 16 digits of p.
const TYPED_MAX = 26;

const SELFTEST = location.hash === '#selftest';
// The self-test keeps its storage in memory for the page's lifetime, so it
// never reads or writes the player's wallet, save or settings.
const memory = SELFTEST ? new Map() : null;

const memoryArea = memory && {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};
// Every storage access is guarded; the game runs without storage.
const storage = createStorage(() => memoryArea || globalThis.localStorage);
const { load, store, unstore } = storage;

/** The real localStorage's slot and legacy keys, as stored, for the self-test's guard. */
function realKeys() {
  return [SLOT_KEY, ...Object.values(LEGACY_KEYS)].map((k) => {
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

// The slot as last parsed, and the legacy slot as last built, each keyed by the
// raw text it came from: the title reads the slot every frame.
let parsed = { raw: undefined, slot: null };
let legacy = { raw: undefined, slot: null };

/**
 * The stored slot; failing that, the legacy slot the old keys describe; else
 * null. A malformed slot reads as absent until the next slot write replaces
 * it. Callers never change the result.
 */
function readSlot() {
  const raw = load(SLOT_KEY);
  if (parsed.raw !== raw) parsed = { raw, slot: parseSlot(raw) };
  if (parsed.slot) return parsed.slot;
  const old = Object.values(LEGACY_KEYS).map((k) => load(k)).join('\u0001');
  if (legacy.raw !== old) legacy = { raw: old, slot: legacySlot(load) };
  return legacy.slot;
}

/** The slot's serial decoded, with the slot's difficulty, or null. */
function readSave() {
  const slot = readSlot();
  const s = slot && decodeSave(slot.save);
  return s && { ...s, difficulty: slot.level };
}

const slotIo = { load, store, remove: unstore };

/**
 * The slot state of the game's run, its serial being `g.serial`. A dead run
 * writes the count any continuation of it carries: its own plus one. Every
 * state carries the takes of the run's recent tombs.
 */
function slotState(g) {
  const { start, solved, continues, state } = g.sim, key = coinKey(g.code, g.world.difficulty);
  return {
    id: g.slotId, save: g.serial, level: g.world.difficulty, start: `${start.u},${start.v}`, solved,
    wallet: g.wallet, tombs: tombSet(g), record: g.paid.get(key) || 0, continues: state === 'over' ? continues + 1 : continues,
    recent: packRecent(g.world, g.sim),
  };
}

/**
 * Writes the run to the slot through `commitSlot` and returns the coins earned.
 * The first write of a clean run takes the slot: a new id and the run's last
 * entry as its serial. A live run adopts the merged continue count; a dead
 * run keeps its own, so every write on one death stores one rise.
 */
function commit(g, pay) {
  if (g.slotId === null) {
    g.slotId = newSlotId();
    g.serial = entryCode(g);
  }
  const state = slotState(g);
  const earned = commitSlot(slotIo, state, pay);
  g.wallet = state.wallet;
  g.paid.set(coinKey(g.code, g.world.difficulty), state.record);
  if (g.sim.state !== 'over') g.sim.continues = state.continues;
  return earned;
}

/** Stores a save of the run in the slot, once the run has taken it; a clean run writes nothing. */
function writeSave(g, text) {
  if (g.slotId === null) return;
  g.serial = text;
  commit(g, () => 0);
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
    // Draws the pause screen over the scene, so a draw-time error fails the gate.
    drawPause({ renderer: r, world, sim, code: SELFTEST_CODE, copied: '', audio: { muted: false }, frame: frameOf(sim.bd, world.size), pauseMap: null, pausedAt: null });
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
  // The slot holds 300 coins and TOMB 20, which boot leaves alone.
  putSlot({ wallet: 300, solved: fakeSolved(20), coins: ['0,0,21'], tombs: ['0,0'], record: 20 });
  // Boot reads the pad's side.
  store(KEY_PAD, 'right');
  const g = boot();
  need(isClean(g), 'boot starts clean');
  need(g.code === 'K7Q2M9XA' && readSlot().wallet === 300, 'the title shows the slot\'s seed and boot leaves the slot');
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

  // Title.
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
  // A serial under another seed, so the title's save code differs from its seed code.
  putSlot({ save: g.code === 'K7Q2M9XA' ? '0000-0000:13' : 'K7Q2-M9XA:13' });
  const saved = decodeSave(readSlot().save);
  need(formatCode(saved.code) !== formatCode(g.code), 'the title shows a save under another seed');
  copies('title', `${formatCode(saved.code)}:${saved.p}`);
  withPrompt('K7Q2-M9XA', () => {
    click('title', 'type');
    need(g.code === 'K7Q2M9XA' && g.typing === null, 'TYPE CODE takes the answer');
  });
  withPrompt(null, () => {
    click('title', 'type');
    need(g.code === 'K7Q2M9XA' && g.typing === null, 'TYPE CODE cancel keeps the code and closes typing');
  });

  // Typing.
  press('KeyT', 't');
  draw(g, 0);
  need(g.typing !== null, 'KeyT opens typing');
  press('KeyP', 'p');
  need(g.screen === 'title' && g.typing === 'P', 'P types a letter in the code field');
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

  difficultyLeg(g, { need, click, press, offEntry });
  coinLeg(g, { need, click, press });
  twoGamesLeg(g, { need, click });
  splashLeg(g, { need, click, press });
  resumeLeg(g, { need, click });
  slotLeg(g, { need, click, press });
  legacyLeg(g, { need, click, press });
  oilLeg(g, { need, click });
  gamepadLeg(g, { need, click, fake });

  // Leave the self-test script's run paused on screen for the screenshot,
  // in the 6x4 world the script was written for.
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

  // The key cycles the four levels, and the preview's tomb size follows.
  setDifficulty(g, 'easy');
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

  // A slot resumes at the difficulty that wrote it, with no run open, as at startup.
  const saveAt = (d) => {
    setDifficulty(g, d);
    click('title', 'begin');
    offEntry();
    earnFake(g);
    click('play', 'pause');
    need(slotNow().level === d, `PAUSE stores ${difficultyLabel(d)} with the save`);
    const where = { x: g.sim.bd.x, y: g.sim.bd.y, sim: g.sim };
    click('pause', 'title');
    g.open = null;
    return where;
  };
  // RESUME with no run open asks CONTINUE?, and the YES key restores the slot.
  const yes = () => softTap(g, click, 'confirm', 'yes');
  const resumesAt = (d, where) => {
    click('title', 'resume');
    need(g.screen === 'title' && g.confirm !== null, `RESUME with no open run asks CONTINUE? at ${difficultyLabel(d)}`);
    yes();
    need(g.screen === 'play' && sized(d), `RESUME rebuilds the save at ${difficultyLabel(d)} and moves the setting`);
    need(g.sim !== where.sim && g.sim.bd.x === where.x && g.sim.bd.y === where.y, `the ${difficultyLabel(d)} save resumes on its board`);
  };
  // A HARD save resumes at HARD, the 4x4 world.
  const hard = saveAt('hard');
  press('ArrowLeft', 'ArrowLeft');
  press('ArrowLeft', 'ArrowLeft');
  need(sized('easy'), 'the setting moves to EASY over a HARD save');
  resumesAt('hard', hard);
  need(g.world.size.w === 4 && g.world.size.h === 4, 'a HARD save resumes in a 4x4 world');
  click('play', 'pause');
  click('pause', 'title');
  g.open = null;
  const old = saveAt('ultimate');
  press('ArrowLeft', 'ArrowLeft');
  press('ArrowLeft', 'ArrowLeft');
  press('ArrowLeft', 'ArrowLeft');
  need(sized('easy'), 'the setting moves to EASY over an ULTIMATE save');
  // A held P or Esc repeats; the title ignores the repeat, as it does Space's.
  press('KeyP', 'p', true);
  need(g.screen === 'title' && g.confirm === null, 'the title ignores an auto-repeated P');
  press('Escape', 'Escape', true);
  need(g.screen === 'title' && g.confirm === null, 'the title ignores an auto-repeated Esc');
  const sideNow = g.side;
  press('KeyH', 'h', true);
  need(g.side === sideNow && load(KEY_PAD) === sideNow, 'the title ignores an auto-repeated H');
  click('title', 'resume');
  yes();
  need(g.screen === 'play' && sized('ultimate') && g.sim.bd.x === old.x && g.sim.bd.y === old.y, 'RESUME plays the ULTIMATE save on its board');
  click('play', 'pause');
  click('pause', 'title');
  g.open = null;
  const easy = saveAt('easy');
  press('ArrowRight', 'ArrowRight');
  need(sized('medium'), 'the setting moves to MEDIUM over an EASY save');
  resumesAt('easy', easy);

  // RESET rolls a new seed and keeps the slot.
  click('play', 'pause');
  click('pause', 'title');
  const kept = load(SLOT_KEY), code = g.code;
  click('title', 'reset');
  need(g.code !== code && kept !== null && load(SLOT_KEY) === kept, 'RESET changes the seed and keeps the slot');

  // The best tomb is per seed and difficulty; ULTIMATE keeps the bare seed code.
  click('title', 'resume');
  store(KEY_BEST, '{}');
  g.sim.solved = new Set(Array.from({ length: 7 }, (_, i) => `${i},0`));
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

/** The `n` fake tombs below row 0 that a self-test run starts with, keyed "u,v". */
const fakeSolved = (n) => Array.from({ length: n }, (_, i) => `0,${-1 - i}`);

/**
 * Scores one tomb along the forward chain: starts a run on the game's world at
 * the first primary cell of tomb (0, 0)'s exit board, with `n` tombs below its
 * row already solved, and walks it out (`walkOut`). It returns the ticks run
 * and the floor coins the walk took.
 */
function oneTombOn(g, n, doomAt = 0) {
  const X = exitBoard(g.world);
  begin(g, X.p, { time: 0, solved: new Set(fakeSolved(n)), lastEntry: X.p, trail: createTrail(), start: { u: 0, v: 0 } });
  return walkOut(g, n, doomAt);
}

/**
 * Walks the run of `n` tombs solved at tomb (0, 0)'s exit board to its chain's
 * last member, Q, the cell across the exit door, until the tomb count reaches
 * n + 1. Throws `touch ...` when the walk runs out of ticks. It returns the
 * ticks run and the floor coins the walk took, which a wallet check nets out.
 * With `doomAt` > 0, the torch is an ember that goes out on that tick. The walk
 * has `budget` ticks.
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

/**
 * A slot of the self-test's MEDIUM seed with nothing earned; `putSlot` fills in what a step changes. It
 * holds no `continues`, as a slot from before the count does.
 */
const SLOT_BASE = {
  id: 'AAAAAAAA', save: 'K7Q2-M9XA:13', level: 'medium', start: '0,0', solved: [], wallet: 0, coins: [], tombs: [], record: 0,
};

/** Stores a slot made of SLOT_BASE and `over`, as text: a step's `coins` list reaches storage as an older build writes it. */
function putSlot(over = {}) {
  store(SLOT_KEY, JSON.stringify({ ...SLOT_BASE, ...over }));
}

/** The stored slot, or null. */
const slotNow = () => parseSlot(load(SLOT_KEY));

/** The `coins` list of the stored slot as written, which an older build reads. */
const storedCoins = () => JSON.parse(load(SLOT_KEY)).coins;

/** True when the game's economy is clean: no slot, wallet 0, no paid tombs and no record. */
const isClean = (g) => g.slotId === null && g.wallet === 0 && [...g.tombs.values()].every((set) => set.size === 0)
  && [...g.paid.values()].every((n) => n === 0);

/** Sends game `h` a keydown, as the window would a key; `h` is a game made by `reload`, with no listener of its own. */
function keyTo(h, code, key, repeat = false) {
  onKeyDown(h, new KeyboardEvent('keydown', { code, key, repeat, bubbles: true, cancelable: true }));
}

/** Draws a frame, so the touch layer places its keys, then clicks soft key `id` of screen `sid`. */
function softTap(g, click, sid, id) {
  draw(g, 0);
  click(sid, id);
}

/** The title with no run open, as at startup. The economy stays as it is. */
function openTitle(g) {
  g.open = null;
  g.confirm = null;
  g.typing = null;
  g.screen = 'title';
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

/** A fresh game over the same storage, as after a page reload. */
function reload() {
  const h = createGame();
  useCode(h, h.code);
  return h;
}

/** The run takes the slot with a coin the board lacks, through the game's own coin path. */
function earnFake(g) {
  collectCoin(g, ['9,9,9']);
}

/**
 * Forgets tomb (0, 0) of the self-test seed at level `d`, and sets its record to
 * `record` (none when 0), in memory and in the slot: the merge restores both from
 * the slot, so the next solve of (0, 0) pays as a first.
 */
function forgetTomb(g, d, record = 0) {
  const key = coinKey(SELFTEST_CODE, d), solved = g.tombs.get(key);
  if (solved) solved.delete('0,0');
  if (record) g.paid.set(key, record); else g.paid.delete(key);
  if (g.slotId !== null) store(SLOT_KEY, serializeSlot(slotState(g)));
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

/** Walks game `h`, torch full, to the floor of cell `goal` { x, y, cell }. Throws `touch ...` when the walk runs out of ticks. */
function walkToCell(h, goal, what) {
  h.sim.burn = BURN_S;
  const auto = createAutopilot(h.world, [goal]);
  const at = () => { const s = h.sim; return s.bd.x === goal.x && s.bd.y === goal.y && s.cell === goal.cell && s.mode === 'floor'; };
  runTicks(h, auto, at, 30000, what);
}

/** The oil steps of the touch leg, from the title with no run open. */
function oilLeg(g, { need, click }) {
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const jars = tombJars(g.world);
  need(jars.length >= 2, 'tomb (0, 0) holds two oil jars at MEDIUM');
  // Each step walks a new run to one jar with the burn pinned to `burn` before
  // every tick until the jar is taken. The contact tick then burns one TICK
  // and adds the jar.
  const take = (jar, burn) => {
    g.screen = 'title';
    draw(g, 0);
    click('title', 'begin');
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

  // CONTINUE? by gamepad: Start asks; A and Start change nothing; Select answers no and B yes.
  const board = g.world.startPoint().board;
  putSlot({ save: encodeSave(SELFTEST_CODE, board.x, board.y), solved: fakeSolved(20), wallet: 300 });
  cleanState(g);
  openTitle(g);
  hold(START);
  hold();
  need(g.screen === 'title' && g.confirm !== null, 'RESUME with no open run asks CONTINUE? by a gamepad\'s Start');
  hold(A);
  hold();
  hold(START);
  hold();
  need(g.screen === 'title' && g.confirm !== null && isClean(g), 'a gamepad answers CONTINUE? A and Start change nothing');
  hold(SELECT);
  hold();
  need(g.screen === 'title' && g.confirm === null && isClean(g), 'a gamepad answers CONTINUE? Select answers no');
  hold(START);
  hold();
  hold(B);
  hold();
  need(g.screen === 'play' && g.wallet === 300 && tombCount(g.sim) === 20, 'a gamepad answers CONTINUE? B answers yes');
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

  // Step 1: the first coin of tomb (0, 0) at MEDIUM takes the slot.
  cleanState(g);
  unstore(SLOT_KEY);
  onLevel('medium');
  openTitle(g);
  click('title', 'begin');
  need(g.screen === 'play' && g.earned === 0, 'BEGIN starts a run with no coins earned');
  const coin = firstCoin(g.world);
  need(coin !== null, 'tomb (0, 0) holds a coin at MEDIUM');
  walkToItem(g, coin);
  need(g.sim.events.includes('coin') && g.wallet === 1, 'touching the first coin adds one to the wallet');
  need(g.earned === 1, 'a coin counts as one earned this run');
  const slot = slotNow();
  need(slot !== null && slot.wallet === 1, 'a touched coin stores the wallet');
  need(slot.level === 'medium' && storedCoins().length === 0, 'a touched coin stores the wallet and no coin in the slot');
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
  resume(later);
  keyTo(later, 'KeyY', 'y');
  need(later.screen === 'play' && takes(later) === 0, 'RESUME after a reload keeps the coin taken');
  openTitle(g);
  click('title', 'begin');
  need(g.screen === 'play' && takes(g) === 1, 'BEGIN lays the coin back');

  // Step 3: each level in a clean state. A tomb solved first pays its rate; a replay pays nothing;
  // a tomb under the record pays, since the record plays no part in it. Each wallet check nets out the
  // floor coins the walk took, which lie back with every new run.
  for (const d of DIFFICULTIES) {
    const label = difficultyLabel(d), key = coinKey(SELFTEST_CODE, d);
    cleanState(g);
    onLevel(d);
    const first = oneTombOn(g, 0);
    need(g.wallet - first.coins === rates[d], `a tomb solved first on this device pays ${rates[d]} at ${label}`);
    const stored = slotNow();
    need(stored.wallet === g.wallet && stored.tombs.includes('0,0') && stored.record === 1 && stored.level === d,
      `the payout stores the wallet, the solved tomb and the record at ${label}`);
    const replay = oneTombOn(g, 0);
    need(g.wallet - first.coins - replay.coins === rates[d], `a replay of a solved tomb pays nothing at ${label}`);
    cleanState(g);
    g.paid.set(key, 50);
    const under = oneTombOn(g, 0);
    need(g.wallet - under.coins === rates[d] && slotNow().record === 50, `a new tomb pays under the record at ${label}`);
  }

  // Step 4: the coins earned this run equal the wallet's gain since BEGIN.
  cleanState(g);
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
  forgetTomb(g, 'medium');
  oneTombOn(g, 1);
  need(g.earned === g.wallet - start, 'the coins earned this run still equal the wallet\'s gain after CONTINUE');
  draw(g, 0);

  // Step 5: the coins and jars of the last two tombs, from a clean state at MEDIUM. A is tomb (0, 0), B the
  // tomb its exit leads to and C the tomb B's exit leads to. A pinned walk holds the burn at 100 s before
  // every tick, so its contact tick shows whether the jar added its 60 s; a long walk starts with the torch
  // full.
  cleanState(g);
  unstore(SLOT_KEY);
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
    resume(h);
    keyTo(h, 'KeyY', 'y');
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
    need(slotNow().recent.map(([tomb]) => tomb).join() === back.sim.recent.join(), 'a walk back into the previous tomb writes the slot\'s recent tombs');
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
function twoGamesLeg(g, { need, click }) {
  // Two games that restored one slot share its id. A second game, made before the first one's write,
  // earns after it; the merge keeps both.
  cleanState(g);
  setDifficulty(g, 'medium');
  useCode(g, SELFTEST_CODE);
  const first = g.world.startPoint().board;
  putSlot({ save: encodeSave(SELFTEST_CODE, first.x, first.y) });
  restore(g, readSlot());
  const other = reload();
  restore(other, readSlot());
  walkToItem(g, firstCoin(g.world));
  collectCoin(other, ['9,9,9']);
  const stored = slotNow();
  need(stored.wallet === 2 && other.wallet === 2 && other.earned === 1, 'two games on one slot keep both coins');
}

/**
 * The splash steps of the touch leg. `oneTombOn(g, 99)` crosses tomb 100
 * through the shipped tick, so each step reads the screen the game chose.
 */
function splashLeg(g, { need, click, press }) {

  // Step 1: the first crossing of tomb 100 shows TORCHBEARER and pays the rate plus 100, at every level.
  for (const d of DIFFICULTIES) {
    cleanState(g);
    setDifficulty(g, d);
    useCode(g, SELFTEST_CODE);
    const key = coinKey(SELFTEST_CODE, d), label = difficultyLabel(d);
    g.paid.set(key, 99);
    const was = g.wallet, earned = g.earned;
    const { coins } = oneTombOn(g, 99);
    need(g.screen === 'splash' && g.splash.k === 1 && rankName(g.splash.k) === 'TORCHBEARER' && g.splash.paid,
      `tomb 100 shows the splash with TORCHBEARER at ${label}`);
    need(g.wallet - was - coins === COIN_RATE[d] + 100, `tomb 100 pays ${COIN_RATE[d]} plus 100 at ${label}`);
    need(g.earned - earned === g.wallet - was, `the milestone payout counts in the coins earned at ${label}`);
    need(slotNow().wallet === g.wallet && slotNow().record === 100, `the ${label} milestone payout stores the wallet and the record`);
    // The tick's entry event stores a save too, so the splash's own write shows only over a stale one.
    store(SLOT_KEY, serializeSlot({ ...slotNow(), save: SLOT_BASE.save }));
    showSplash(g, g.splash.k, g.splash.paid);
    need(slotNow().save === hereCode(g), `the ${label} splash stores the save`);
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

  // Step 4: the second crossing shows the splash and pays nothing.
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

  // Step 7: a run that ends on the tick that crosses tomb 100 shows the end screen, and the payout stands.
  const { ticks } = oneTombOn(g, 99);
  const level = g.world.difficulty;
  forgetTomb(g, level, 99);
  const before = g.wallet;
  const ended = oneTombOn(g, 99, ticks);
  need(g.screen === 'over' && tombCount(g.sim) === 100, 'a run that ends on the crossing of tomb 100 shows the end screen');
  need(g.wallet - before - ended.coins === COIN_RATE[level] + 100, 'the payout stands when the run ends on the crossing of tomb 100');
  draw(g, 0);
}

/**
 * The RESUME steps of the touch leg, from the title with no run open. Each
 * `reload` is a fresh game over the same storage, as after a page reload.
 */
function resumeLeg(g, { need, click }) {
  const level = 'medium', key = coinKey(SELFTEST_CODE, level);
  setDifficulty(g, level);
  useCode(g, SELFTEST_CODE);
  openTitle(g);
  click('title', 'begin');
  oneTombOn(g, 1);
  const count = tombCount(g.sim);
  draw(g, 0);
  click('play', 'pause');
  const saved = slotNow().save;

  // The count survives a reload through the slot.
  const resumed = reload();
  resume(resumed);
  keyTo(resumed, 'KeyY', 'y');
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

  // A run resumed at TOMB 99 crosses 100 under a record of 100: the splash shows unpaid and only the tomb pays.
  const exit = exitBoard(g.world), at = encodeSave(SELFTEST_CODE, exit.x, exit.y);
  putSlot({ save: at, solved: fakeSolved(99), record: 100 });
  const late = reload();
  resume(late);
  keyTo(late, 'KeyY', 'y');
  need(tombCount(late.sim) === 99 && late.paid.get(key) === 100, 'RESUME after a reload continues at TOMB 99');
  const was = late.wallet;
  const { coins } = walkOut(late, 99);
  need(late.screen === 'splash' && late.splash.k === 1 && !late.splash.paid && late.wallet - was - coins === COIN_RATE[level],
    'a resumed run crossing tomb 100 below the record pays no milestone');
}

/**
 * The save slot steps of the touch leg, from the title with no run open: a
 * clean start, CONTINUE? over the slot from RESUME and TYPE CODE, a new run
 * taking the slot on its first coin and the continue count.
 */
function slotLeg(g, { need, click, press }) {
  const level = 'medium';
  setDifficulty(g, level);
  useCode(g, SELFTEST_CODE);
  const coin = firstCoin(g.world), id = coinId(coin.bd, coin.cell, coin.i), first = g.world.startPoint().board;
  const serial = encodeSave(SELFTEST_CODE, first.x, first.y);
  // The slot holds 300 coins, a coin listed as an older build writes it, TOMB 20 and no continue count,
  // at tomb (0, 0)'s first board.
  const hold = () => putSlot({ save: serial, solved: fakeSolved(20), wallet: 300, coins: [id], tombs: ['0,0'], record: 20 });
  const toTitle = () => {
    hold();
    cleanState(g);
    openTitle(g);
  };
  const typeIn = (text) => withPrompt(text, () => softTap(g, click, 'title', 'type'));
  const tap = (sid, which) => softTap(g, click, sid, which);
  // CONTINUE? stands on the title over the slot.
  const over = () => g.screen === 'title' && g.confirm !== null && g.confirm.slot.wallet === 300 && g.confirm.slot.solved.length === 20;
  // ...and has restored nothing.
  const asks = () => over() && isClean(g);
  // The title after a played, restored run: wallet 300 under slot AAAAAAAA, not clean.
  const played = () => {
    toTitle();
    tap('title', 'resume');
    press('KeyY', 'y');
    endRun(g);
    tap('over', 'title');
    need(g.screen === 'title' && g.slotId === SLOT_BASE.id && g.wallet === 300, 'a played run leaves the title with its wallet');
  };
  const restored = () => g.screen === 'play' && g.slotId === SLOT_BASE.id && g.wallet === 300 && tombCount(g.sim) === 20
    && g.sim.collected.size === 0;

  // A typed serial on another seed starts clean.
  toTitle();
  typeIn('K7Q2-M9XA:13');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'a new serial starts with no coins');

  // RESUME with no run open asks CONTINUE?; N, from RESUME and from TYPE CODE, returns to a clean title and keeps the slot.
  toTitle();
  tap('title', 'resume');
  need(asks(), 'RESUME with no open run asks CONTINUE? by the touch RESUME key');
  press('KeyN', 'n');
  need(g.screen === 'title' && g.confirm === null && g.open === null && isClean(g) && readSlot().wallet === 300,
    'N returns to the title with no coins from RESUME');
  press('KeyP', 'p');
  need(asks(), 'RESUME with no open run asks CONTINUE? by P');
  press('KeyN', 'n');
  typeIn(serial);
  press('Escape', 'Escape');
  need(g.screen === 'title' && g.confirm === null, 'Esc answers no to CONTINUE?');
  typeIn(serial);
  need(asks(), 'TYPE CODE with the slot\'s serial asks CONTINUE?');
  press('KeyN', 'n');
  need(g.screen === 'title' && g.confirm === null && isClean(g) && readSlot().wallet === 300, 'N returns to the title with no coins from TYPE CODE');
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
  need(g.wallet === 301 && g.earned === 1, 'a coin the slot lists lies back and pays one');
  endRun(g);
  draw(g, 0);
  click('over', 'continue');
  need(g.screen === 'play' && g.slotId === SLOT_BASE.id && g.wallet === 301 && slotNow().id === SLOT_BASE.id, 'Continue keeps the run\'s slot and coins');
  toTitle();
  typeIn(serial);
  press('Enter', 'Enter');
  need(restored(), 'Enter answers yes to CONTINUE? from TYPE CODE');

  // Y restores the slot CONTINUE? showed, not whatever is stored when Y comes.
  toTitle();
  tap('title', 'resume');
  need(asks(), 'RESUME with no open run asks CONTINUE? before the slot changes');
  putSlot({ id: 'BBBBBBBB', save: encodeSave(SELFTEST_CODE, first.x + 1, first.y), wallet: 7 });
  press('KeyY', 'y');
  need(restored() && slotNow().id === SLOT_BASE.id, 'Y restores the snapshot CONTINUE? showed');

  // Each way to a clean state cleans a title left by a played run, not only a clean one.
  played();
  tap('title', 'reset');
  need(isClean(g) && g.screen === 'title', 'RESET starts clean');
  played();
  typeIn('K7Q2-M9XA');
  need(isClean(g) && g.screen === 'title', 'a typed seed starts clean');
  played();
  typeIn('K7Q2-M9XA:13');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'a typed serial other than the slot\'s starts clean');
  played();
  tap('title', 'resume');
  need(over(), 'RESUME with no open run asks CONTINUE? after a played run');
  press('KeyN', 'n');
  need(g.screen === 'title' && g.confirm === null && isClean(g), 'N returns to the title with no coins after a played run');

  // BEGIN after a restored run starts clean.
  toTitle();
  tap('title', 'resume');
  press('KeyY', 'y');
  endRun(g);
  tap('over', 'title');
  tap('title', 'begin');
  need(g.screen === 'play' && isClean(g) && tombCount(g.sim) === 0, 'BEGIN after a restored run starts with no coins at TOMB 0');

  // N, BEGIN and a PAUSE before any coin leave the slot standing.
  toTitle();
  tap('title', 'resume');
  press('KeyN', 'n');
  tap('title', 'begin');
  draw(g, 0);
  click('play', 'pause');
  const later = reload();
  resume(later);
  need(later.confirm !== null && later.confirm.slot.wallet === 300 && later.confirm.slot.solved.length === 20,
    'the slot outlives N until a new run earns');

  // The soft keys answer CONTINUE?.
  toTitle();
  tap('title', 'resume');
  tap('confirm', 'no');
  need(g.screen === 'title' && g.confirm === null && isClean(g), 'the soft keys answer CONTINUE? NO');
  tap('title', 'resume');
  tap('confirm', 'yes');
  need(restored(), 'the soft keys answer CONTINUE? YES');

  // After N, a run on the slot's seed starts at 0, and its first coin takes the slot.
  toTitle();
  tap('title', 'resume');
  press('KeyN', 'n');
  tap('title', 'begin');
  walkToItem(g, coin);
  need(g.wallet === 1, 'after N, BEGIN on the slot\'s seed earns from 0');
  const taken = slotNow();
  need(taken.id === g.slotId && taken.id !== SLOT_BASE.id && taken.wallet === 1 && storedCoins().length === 0 && taken.solved.length === 0
    && taken.tombs.length === 0 && taken.record === 0, 'a new run\'s first coin takes the slot');

  // The continue count: only a death raises it. Each death ends the torch through the sim, so the tick's own
  // endRun writes; a bare endRun leaves the run live and stores no rise.
  const die = () => {
    g.sim.burn = 0;
    g.sim.ember = TICK / 2;
    runTicks(g, () => [0, 0, false], () => g.screen === 'over', 10, 'the torch dies');
  };
  toTitle();
  tap('title', 'resume');
  press('KeyY', 'y');
  need(restored() && g.sim.continues === 0, 'Y restores a slot without a count at 0 continues');
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
  need(g.sim.continues === 1 && slotNow().continues === 2, 'a second death stores 2 in the slot while the end screen shows 1');
  draw(g, 0);
  press('KeyQ', 'q');
  need(g.screen === 'title', 'Q leaves the end screen for the title');
  tap('title', 'resume');
  press('KeyY', 'y');
  need(restored() && g.sim.continues === 2, 'Q, RESUME and Y restore the stored count of 2');
  draw(g, 0);
  click('play', 'pause');
  const after = reload();
  resume(after);
  keyTo(after, 'KeyY', 'y');
  need(after.screen === 'play' && after.sim.continues === 2 && slotNow().continues === 2, 'a PAUSE, a reload, RESUME and Y hold the count at 2');
  openTitle(g);
  click('title', 'begin');
  need(g.screen === 'play' && g.sim.continues === 0, 'BEGIN starts the continue count at 0');

  // Two live games on one slot share the count by maximum: one dies, the other's next write adopts the rise.
  toTitle();
  tap('title', 'resume');
  press('KeyY', 'y');
  const twin = reload();
  resume(twin);
  keyTo(twin, 'KeyY', 'y');
  need(restored() && twin.screen === 'play' && twin.sim.continues === 0, 'two games restore one slot at 0 continues');
  die();
  need(slotNow().continues === 1 && twin.sim.continues === 0, 'a death stores the raised count before the other game writes');
  commit(twin, () => 0);
  need(twin.sim.continues === 1 && slotNow().continues === 1, 'a live game adopts another\'s death on its next write');
}

/**
 * The migration steps of the touch leg, from the title with no run open. The
 * seven old keys hold a HARD save, TOMB 20 and a wallet of 57; the first slot
 * write removes them.
 */
function legacyLeg(g, { need, click, press }) {
  // The stacked world's save difficulty, which a plane save never reads.
  const STACKED = 'infinite-maze.save.difficulty';
  const level = 'hard', key = coinKey(SELFTEST_CODE, level), stranger = coinKey('K7Q2M9XA', level);
  setDifficulty(g, level);
  useCode(g, SELFTEST_CODE);
  const coin = firstCoin(g.world), id = coinId(coin.bd, coin.cell, coin.i), first = g.world.startPoint().board;
  const serial = encodeSave(SELFTEST_CODE, first.x, first.y);
  // A device that played before the slot, with another seed's coins, tombs and record beside the save's.
  const oldKeys = ({ save = serial, difficulty = level, run = { save: serial, start: '0,0', solved: fakeSolved(20) } } = {}) => {
    unstore(SLOT_KEY);
    store(LEGACY_KEYS.save, save);
    if (difficulty) store(LEGACY_KEYS.difficulty, difficulty); else unstore(LEGACY_KEYS.difficulty);
    if (run) store(LEGACY_KEYS.run, JSON.stringify(run)); else unstore(LEGACY_KEYS.run);
    store(LEGACY_KEYS.wallet, '57');
    store(LEGACY_KEYS.coins, JSON.stringify({ [key]: [id], [stranger]: ['1,1,1'] }));
    store(LEGACY_KEYS.tombs, JSON.stringify({ [key]: ['0,0'], [stranger]: ['5,5'] }));
    store(LEGACY_KEYS.paid, JSON.stringify({ [key]: 20, [stranger]: 9 }));
  };
  const gone = () => Object.values(LEGACY_KEYS).every((k) => load(k) === null);
  const tap = (sid, which) => softTap(g, click, sid, which);
  // RESUME over the old keys, with nothing open.
  const ask = () => {
    cleanState(g);
    openTitle(g);
    tap('title', 'resume');
    return g.confirm;
  };

  // Y adopts the device wallet and writes the slot at once, which removes the old keys.
  oldKeys();
  need(ask() !== null, 'RESUME over a legacy save asks CONTINUE?');
  const slot = g.confirm.slot;
  need(slot.wallet === 57 && slot.solved.length === 20 && slot.level === level, 'a legacy save keeps its wallet, TOMB and difficulty');
  need(load(SLOT_KEY) === null && !gone(), 'a legacy slot waits for Y before it is stored');
  press('KeyY', 'y');
  need(g.screen === 'play' && g.wallet === 57 && tombCount(g.sim) === 20 && g.difficulty === level && g.tombs.size === 1
    && [...g.tombs.get(key)].join() === '0,0' && g.paid.get(key) === 20, 'a legacy save restores only its own seed\'s sets');
  need(slotNow() !== null && slotNow().id === g.slotId && slotNow().wallet === 57 && gone(), 'a legacy save adopts the device wallet once on Y');

  // A new run's first coin takes the slot, and the legacy wallet is gone with it.
  oldKeys();
  ask();
  press('KeyN', 'n');
  need(g.confirm === null && slotNow() === null && !gone(), 'N leaves the legacy keys as they were');
  tap('title', 'begin');
  walkToItem(g, coin);
  const later = reload();
  resume(later);
  need(g.wallet === 1 && gone() && later.confirm !== null && later.confirm.slot.wallet === 1, 'a legacy wallet is gone once a new run takes the slot');

  // A save with no difficulty beside it plays at ULTIMATE, the 6x4 world, whatever the stacked world's save left.
  oldKeys({ difficulty: null });
  store(STACKED, 'easy');
  ask();
  need(g.confirm.slot.level === 'ultimate', 'a legacy save with no stored difficulty adopts at ULTIMATE');
  press('KeyY', 'y');
  need(g.screen === 'play' && g.difficulty === 'ultimate' && g.world.difficulty === 'ultimate', 'Y plays a legacy save with no stored difficulty at ULTIMATE');
  unstore(STACKED);

  // The run counts only when it names the save.
  // A save in tomb (1, 0) with no run starts there, as a typed save code does, so its tombs can count.
  const board = boardCoords(1, 0, 0, g.world.size), elsewhere = encodeSave(SELFTEST_CODE, board.x, board.y);
  oldKeys({ save: elsewhere, run: null });
  ask();
  need(g.confirm.slot.solved.length === 0 && g.confirm.slot.start === '1,0', 'a legacy save without a run resumes at its own tomb');
  press('KeyY', 'y');
  need(g.screen === 'play' && tombCount(g.sim) === 0 && g.sim.start.u === 1 && g.sim.start.v === 0 && slotNow().start === '1,0',
    'Y plays a legacy save without a run from its own tomb');
  oldKeys({ run: { save: encodeSave(SELFTEST_CODE, first.x + 1, first.y), start: '0,0', solved: fakeSolved(20) } });
  ask();
  need(g.confirm.slot.solved.length === 0, 'a legacy run naming another save resumes at TOMB 0');

  // A slot beside the old keys wins, and the old keys are not offered.
  putSlot({ wallet: 3 });
  need(readSlot().wallet === 3, 'a stored slot outranks the legacy keys');
  cleanState(g);
  g.confirm = null;
  unstore(SLOT_KEY);
  for (const k of Object.values(LEGACY_KEYS)) unstore(k);
}

const DIRS = {
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
};
const DIR_BITS = { l: KEY.L, r: KEY.R, u: KEY.U, d: KEY.D };
const JUMP_KEYS = ['Space', 'KeyZ'];
// Title keys that step the difficulty setting, stopping at the ends.
const SETTING_STEP = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };

// ULTIMATE, the 6x4 world, keeps the bare seed code, so bests from before
// difficulties carry over.
function bestKey(code, difficulty) {
  return difficulty === 'ultimate' ? code : `${code}:${difficultyLabel(difficulty)}`;
}

function readBest(code, difficulty) {
  try { return JSON.parse(load(KEY_BEST) || '{}')[bestKey(code, difficulty)] ?? null; } catch { return null; }
}

/** Keeps the most tombs solved per seed and difficulty. */
function writeBest(code, difficulty, solved) {
  const key = bestKey(code, difficulty);
  let all = {};
  try { all = JSON.parse(load(KEY_BEST) || '{}'); } catch { all = {}; }
  if (all[key] === undefined || solved > all[key]) { all[key] = solved; store(KEY_BEST, JSON.stringify(all)); }
}

/** The paid tombs of the game's seed and level, made when absent, which the tomb pay fills. */
function tombSet(g) {
  const key = coinKey(g.code, g.world.difficulty);
  let set = g.tombs.get(key);
  if (!set) {
    set = new Set();
    g.tombs.set(key, set);
  }
  return set;
}

/** The economy of a clean state: no slot, wallet 0, no paid tombs. A new Map keeps a left-open run's sets. */
function cleanState(g) {
  Object.assign(g, { slotId: null, serial: '', wallet: 0, tombs: new Map(), paid: new Map() });
}

/** The fields of the game's economy, which a run left open takes with it. */
function economyOf(g) {
  const { slotId, serial, wallet, tombs, paid } = g;
  return { slotId, serial, wallet, tombs, paid };
}

/** The entries a set gained after it held `before`; a Set iterates in insertion order. */
function appended(set, before) {
  return set.size > before ? [...set].slice(before) : [];
}

/** A tick took `coins`, one entry for each of its 'coin' events: pays one each and counts them earned. */
function collectCoin(g, coins) {
  g.earned += commit(g, coinPay(coins));
}

/**
 * Pays the tombs the tick solved and the milestone it crossed; returns the pay
 * rule, whose `seen` is the record the merge found, or null when no tomb was
 * solved.
 */
function payTombs(g, solvedNow) {
  if (solvedNow.length === 0) return null;
  const level = g.world.difficulty;
  const pay = tombPay(coinKey(g.code, level), level, solvedNow, tombCount(g.sim));
  g.earned += commit(g, pay);
  return pay;
}

/** State shared by input, tick and draw. */
function createGame() {
  // A visit ends whenever the screen is written, even back to the same one.
  let screen = 'title', visit = 0;
  return {
    get screen() { return screen; },
    set screen(next) { screen = next; visit++; },
    get visit() { return visit; },
    // A game starts clean: wallet 0, no paid tombs or record, and no slot.
    slotId: null, serial: '', wallet: 0, tombs: new Map(), paid: new Map(),
    // CONTINUE? on the title: { slot }, the stored slot a Y restores; null when not asked.
    confirm: null,
    // The coins the wallet has gained since the run began; Continue carries them.
    earned: 0,
    audio: createAudio(), keys: new Set(), cam: { x: 0, y: 0 },
    // Key edges since the last tick: KEY bits pressed and released, and a jump press.
    press: 0, release: 0, jump: false,
    code: parseCode((readSave() || {}).code || '') || rollCode(),
    // The side of the d-pad: 'left' or 'right'.
    side: padSide(load(KEY_PAD)),
    // The title's setting; `world` is always built at it.
    difficulty: storedDifficulty(KEY_DIFFICULTY, 'medium'),
    world: null, renderer: null, sim: null, preview: null,
    // The run left for the title by Q: { code, world, renderer, preview, sim }.
    open: null,
    // The milestone the splash shows: { k, paid }, where paid is whether this crossing paid.
    splash: null,
    typing: null, note: '', footFrame: -1, climbFrame: -1,
    // The tomb { u, v } the pause map frames, and its model.
    frame: { u: 0, v: 0 }, pauseMap: null, pausedAt: null,
  };
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
 * Continue carries them and a restore of the slot unpacks them. Any other
 * start takes none, and every coin and jar lies back.
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
  play(g);
}

/**
 * Begins at save position p; with a `run`, its solved tombs, start tomb,
 * continue count and recent takes carry over.
 */
function beginSaved(g, p, run) {
  begin(g, p, run && {
    time: 0, solved: run.solved, start: run.start, lastEntry: p, continues: run.continues,
    recent: run.recent, collected: run.collected, jars: run.jars,
  });
  g.earned = 0;
}

/** BEGIN: a run from tomb (0, 0) with a clean economy. */
function beginClean(g) {
  cleanState(g);
  begin(g);
}

/**
 * Restores `slot` into memory and begins its run at the serial's position, at
 * the slot's difficulty, with its start tomb, solved tombs, wallet, continue
 * count and the takes of its recent tombs. The setting follows. The write that
 * follows adopts a legacy slot.
 */
function restore(g, slot) {
  const at = decodeSave(slot.save), key = coinKey(at.code, slot.level);
  keepSetting(g, slot.level);
  if (at.code !== g.code || g.world.difficulty !== slot.level) useCode(g, at.code);
  Object.assign(g, {
    slotId: slot.id, serial: slot.save, wallet: slot.wallet,
    tombs: new Map([[key, new Set(slot.tombs)]]), paid: new Map([[key, slot.record]]),
  });
  const [u, v] = slot.start.split(',').map(Number);
  beginSaved(g, at.p, { solved: new Set(slot.solved), start: { u, v }, continues: slot.continues, ...unpackRecent(g.world, slot.recent) });
  commit(g, () => 0);
}

/**
 * RESUME: back to the open run unchanged, or with none open, CONTINUE? over the
 * stored slot. Either way the setting follows the run once restored.
 */
function resume(g) {
  const o = g.open;
  if (o) {
    g.open = null;
    Object.assign(g, economyOf(o), { code: o.code, world: o.world, renderer: o.renderer, preview: o.preview, sim: o.sim });
    keepSetting(g, o.world.difficulty);
    play(g);
    return;
  }
  const slot = readSlot();
  if (slot) g.confirm = { slot };
}

/** Answers CONTINUE?: yes restores the slot it names, no starts the title clean. */
function confirmKey(g, e) {
  if (e.repeat) return;
  if (e.code === 'KeyY' || e.key === 'Enter') {
    const { slot } = g.confirm;
    g.confirm = null;
    restore(g, slot);
  } else if (e.code === 'KeyN' || e.code === 'KeyQ' || e.key === 'Escape') {
    g.confirm = null;
    cleanState(g);
    useCode(g, g.code);
  }
}

function hereCode(g) {
  return encodeSave(g.code, g.sim.bd.x, g.sim.bd.y);
}

function entryCode(g) {
  const { x, y } = boardOfPos(g.sim.lastEntry);
  return encodeSave(g.code, x, y);
}

function submitTyped(g) {
  const save = decodeSave(g.typing);
  if (save) {
    g.typing = null;
    // A code carries no count or coins: only the slot's own serial restores the slot.
    const slot = readSlot(), kept = slot && decodeSave(slot.save);
    if (kept && kept.code === save.code && kept.p === save.p) {
      if (save.code !== g.code) useCode(g, save.code);
      g.confirm = { slot };
      return;
    }
    cleanState(g);
    if (save.code !== g.code) useCode(g, save.code);
    beginSaved(g, save.p, null);
    return;
  }
  const c = parseCode(g.typing);
  if (c) { cleanState(g); useCode(g, c); g.typing = null; g.note = ''; return; }
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

function titleKey(g, e) {
  if (g.confirm) { confirmKey(g, e); return; }
  if (g.typing !== null) { typingKey(g, e); return; }
  const at = DIFFICULTIES.indexOf(g.difficulty);
  if (e.key === 'Enter' || (e.code === 'Space' && !e.repeat)) beginClean(g);
  else if (e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }
  else if (e.code === 'KeyR') { cleanState(g); useCode(g, rollCode()); g.note = ''; }
  else if (e.code === 'KeyT') { g.typing = ''; g.note = ''; }
  else if (e.code === 'KeyL') setDifficulty(g, DIFFICULTIES[(at + 1) % DIFFICULTIES.length]);
  else if (e.code === 'KeyH') {
    if (!e.repeat) {
      g.side = g.side === 'left' ? 'right' : 'left';
      store(KEY_PAD, g.side);
    }
  }
  else if (SETTING_STEP[e.code]) {
    setDifficulty(g, DIFFICULTIES[Math.max(0, Math.min(DIFFICULTIES.length - 1, at + SETTING_STEP[e.code]))]);
  } else if (e.code === 'KeyK') {
    // The save code the title shows, or the seed code when it shows none.
    const s = readSave();
    const shown = s ? `${formatCode(s.code)}:${s.p}` : formatCode(g.code);
    copyWithStatus(globalThis.navigator.clipboard, shown, (status) => { g.note = status; }, visitLive(g));
  }
}

function playKey(g, e) {
  if (e.code === 'KeyP' || e.key === 'Escape') {
    g.screen = 'pause';
    g.frame = frameOf(g.sim.bd, g.world.size);
    g.pauseMap = null;
    g.pausedAt = null;
    writeSave(g, hereCode(g));
    return;
  }
  if (DIRS[e.code]) {
    g.keys.add(DIRS[e.code]);
    if (!e.repeat) g.press |= DIR_BITS[DIRS[e.code]];
  }
  if (JUMP_KEYS.includes(e.code) && !e.repeat) g.jump = true;
}

/** Goes to the title with the run open: RESUME there returns to it unchanged. */
function leaveOpen(g) {
  g.open = { ...economyOf(g), code: g.code, world: g.world, renderer: g.renderer, preview: g.preview, sim: g.sim };
  g.screen = 'title';
  titleCam(g);
}

// g.copied: the copy status the pause or end screen shows, cleared on leaving it.
function pauseKey(g, e) {
  if (e.code === 'KeyP' || e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }
  else if (e.code === 'KeyQ') {
    leaveOpen(g);
    g.copied = '';
  } else if (e.code === 'KeyC') {
    copyWithStatus(globalThis.navigator.clipboard, hereCode(g), (status) => { g.copied = status; }, visitLive(g));
  } else if (DIRS[e.code] && !e.repeat) g.frame = panFrame(g.frame, DIRS[e.code]);
}

function overKey(g, e) {
  const s = g.sim;
  if (e.key === 'Enter' || (e.code === 'Space' && !e.repeat)) {
    g.copied = '';
    begin(g, s.lastEntry, { ...runCarry(s), continues: s.continues + 1 });
  } else if (e.code === 'KeyQ' || e.key === 'Escape') { g.screen = 'title'; g.copied = ''; titleCam(g); }
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

const SCREEN_KEYS = { title: titleKey, play: playKey, pause: pauseKey, over: overKey, splash: splashKey };

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
    if (ev === 'solved') { g.audio.play('band'); writeBest(g.code, g.world.difficulty, s.solved.size); }
    if (ev === 'entry') writeSave(g, entryCode(g));
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
  writeBest(g.code, g.world.difficulty, g.sim.solved.size);
  writeSave(g, entryCode(g));
}

/** Shows the splash for milestone k and stores the save, as PAUSE does. */
function showSplash(g, k, paid) {
  g.screen = 'splash';
  g.splash = { k, paid };
  writeSave(g, hereCode(g));
}

/**
 * The milestone a tick reached, as { k, paid }, or null; `was` and `count` are
 * the tomb count before and after the tick, and `seen` the payout record the
 * merge found, so a crossing the record already passed shows the splash unpaid.
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
  // Only the step adds to the solved set; a commit leaves it alone. Each coin the step takes pushes
  // one 'coin' event, which a drop of the tomb the explorer left does not undo.
  const solvedNow = appended(s.solved, was), coins = s.events.filter((ev) => ev === 'coin');
  handleEvents(g);
  if (coins.length) collectCoin(g, coins);
  const pay = payTombs(g, solvedNow);
  // A jar take and a change of tomb reach the slot on their tick, once the run holds it. A step that
  // changes tomb drops ids, so the jar count alone cannot tell a take there; the change writes anyway.
  if (g.slotId !== null && (s.recent[0] !== lead || s.jars.size > jars)) commit(g, () => 0);
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

function drawTitle(g, t) {
  const r = g.renderer;
  r.scene(g.preview, g.cam, t);
  const saved = readSave();
  const best = titleBest(g);
  r.ctx.fillStyle = shade(0.45);
  r.ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  if (storage.failed()) r.text('SAVES OFF: COPY YOUR CODE', VIEW_W / 2, 4, 'o', { align: 'center' });
  r.text('INFINITE MAZE', VIEW_W / 2, 18, 'm', { align: 'center', scale: 2 });
  r.text('A TOMB WITHOUT END', VIEW_W / 2, 38, 'a', { align: 'center' });
  r.panel(62, 50, 196, g.confirm || saved || g.typing !== null ? 100 : 88);
  if (!g.confirm) r.text(`SEED  ${formatCode(g.code)}`, VIEW_W / 2, 58, 'i', { align: 'center' });
  if (g.confirm) {
    const { save, level, solved, wallet, continues } = g.confirm.slot;
    r.text('CONTINUE?', VIEW_W / 2, 58, 'i', { align: 'center' });
    r.text(save, 72, 74, 'c');
    r.text(`${difficultyLabel(level)}  TOMB ${solved.length}`, 72, 86, 'b');
    r.text(`COINS  ${wallet}  CONTINUES  ${continues}`, 72, 98, 'b');
    r.text('Y YES  N NO', 72, 114, 'p');
  } else if (g.typing !== null) {
    // No label, so TYPED_MAX characters and the cursor fit the panel.
    r.text(`${g.typing}${Math.floor(t * 2) % 2 ? '_' : ' '}`, 72, 74, 'c');
    r.text('ENTER  ACCEPT', 72, 90, 'b');
    r.text('ESC    CANCEL', 72, 102, 'b');
    r.text('SEED  XXXX-XXXX', 72, 118, '9');
    r.text('SAVE  XXXX-XXXX:P', 72, 130, '9');
  } else {
    r.text('ENTER  BEGIN', 72, 74, 'c');
    drawSettingRow(g, 86);
    r.text('R      RESET', 72, 98, 'b');
    r.text('K COPY', 248, 98, 'b', { align: 'right' });
    r.text('T      TYPE A CODE', 72, 110, 'b');
    // At most 28 characters right of P: a 9-character p and ULTIMATE fit the panel.
    if (saved) {
      r.text('P', 72, 122, 'b');
      r.text(`${formatCode(saved.code)}:${saved.p} ${difficultyLabel(saved.difficulty)}`, 248, 122, 'b', { align: 'right' });
    }
    r.text(best === null ? 'THE MOUTH OF THE TOMB' : `BEST TOMB  ${best}`, VIEW_W / 2, saved ? 136 : 124, 'p', { align: 'center' });
  }
  if (g.note) r.text(g.note, VIEW_W / 2, 152, 'o', { align: 'center' });
  r.text(touch && touch.on ? 'D-PAD MOVE  RED BUTTON JUMP' : 'ARROWS/WASD MOVE  SPACE/Z JUMP  M MUTE  P PAUSE', VIEW_W / 2, 166, '9', { align: 'center' });
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

// The panel spans y 2..177; its rules leave y 5..174 for rows at least 4 px apart.
function drawPause(g, t = 0) {
  const r = g.renderer;
  r.panel(50, 2, 220, 176);
  r.text('PAUSED', VIEW_W / 2, 9, 'm', { align: 'center', scale: 2 });
  r.text(`CONTINUES ${g.sim.continues}`, 53, 16, 'a');
  r.text(`TOMB ${g.sim.solved.size}`, 267, 16, 'a', { align: 'right' });
  if (g.pausedAt === null) g.pausedAt = t;
  const o = mapOrigin(g.world);
  r.drawMap(pauseModel(g), o.x, o.y, t - g.pausedAt);
  r.text(saveLabel(g.copied), VIEW_W / 2, 118, 'a', { align: 'center' });
  r.text(`${hereCode(g)}  ${difficultyLabel(g.world.difficulty)}`, VIEW_W / 2, 129, 'i', { align: 'center' });
  r.text(g.audio.muted ? 'SOUND OFF' : 'SOUND ON', VIEW_W / 2, 141, '9', { align: 'center' });
  r.text('P RESUME  ARROWS PAN  Q TITLE', VIEW_W / 2, 153, 'b', { align: 'center' });
  r.text('M MUTE  C COPY', VIEW_W / 2, 164, 'b', { align: 'center' });
}

function drawOver(g) {
  const r = g.renderer, s = g.sim;
  r.panel(40, 34, 240, 124);
  r.text('THE TORCH IS OUT', VIEW_W / 2, 44, 'o', { align: 'center', scale: 2 });
  r.text(`TOMBS CLIMBED  ${s.solved.size}`, VIEW_W / 2, 68, 'c', { align: 'center' });
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
  if (g.screen === 'title') {
    drawTitle(g, t);
  } else {
    g.renderer.scene(g.sim, g.cam, t);
    g.renderer.hud(g.sim, g.wallet);
    if (g.screen === 'pause') drawPause(g, t);
    else if (g.screen === 'over') drawOver(g);
    else if (g.screen === 'splash') drawSplash(g);
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
  r.text(errorLine(g.serial, formatCode(g.code)), VIEW_W / 2, ERROR_STRIP.y + 8, 'o', { align: 'center' });
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
  const g = createGame();
  // A layout change moves the title's explorer with it.
  const refit = () => {
    fit();
    if (g.screen === 'title' && g.preview) titleCam(g);
  };
  touch = createTouch({
    state: () => ({
      screen: g.screen, typing: g.typing !== null, confirm: g.confirm !== null, muted: g.audio.muted, difficulty: g.difficulty, side: g.side,
      resume: g.screen === 'title' && (g.open !== null || readSave() !== null),
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
