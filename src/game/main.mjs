// Boot, input, the fixed 60 Hz loop and the title, play, pause, end and
// milestone splash screens. `#selftest` in the URL runs the self-test instead.
import { createWorld, boardOfPos, boardCoords } from '../world/world.mjs';
import { DIFFICULTY, DIFFICULTIES } from '../world/band.mjs';
import { parseCode, formatCode, codeFromBytes } from '../world/hash.mjs';
import { encodeSave, decodeSave } from '../world/save.mjs';
import { floorItems, itemSpot } from '../world/floor.mjs';
import {
  createSim, step, runCarry, TICK, BURN_S, KEY, feet, pose, nodeXY, tombCount, inputEdges, createTrail,
} from './sim.mjs';
import { createRenderer, VIEW_W, VIEW_H, MAP_SCALE, shade } from './render.mjs';
import { createAudio } from './audio.mjs';
import { runScript, createAutopilot, SELFTEST_CODE } from './autopilot.mjs';
import {
  COIN_RATE, tombPayout, coinKey, coinId, parseWallet, parseCollected, parsePaid, serializeCollected, serializePaid,
} from './wallet.mjs';
import { createGamepad } from './gamepad.mjs';
import { createTouch, layout, viewport, difficultyLabel, padSide, titleFeet, PANEL_X, textWidth } from './touch.mjs';
import { MILESTONE, rankName } from './ranks.mjs';
import { copyWithStatus, saveLabel } from './clipboard.mjs';
import { frameOf, panFrame, sameFrame, mapModel, mapCells } from './map.mjs';
import { RGB, idx } from './art.mjs';

// Saves and bests of the tomb plane keep keys of their own, so a stacked-world
// value never reads as a position or a score.
const KEY_SAVE = 'infinite-maze.plane.save';
// The difficulty of the run that wrote KEY_SAVE; absent means ULTIMATE, the
// 6x4 world and the only size before difficulties.
const KEY_SAVE_DIFFICULTY = 'infinite-maze.plane.save.difficulty';
// The title's difficulty setting; absent means MEDIUM.
const KEY_DIFFICULTY = 'infinite-maze.difficulty';
// The d-pad's side, 'left' or 'right'; anything else reads 'left'.
const KEY_PAD = 'infinite-maze.pad';
const KEY_BEST = 'infinite-maze.plane.best';
// Coins. The wallet depends on no world layout, so it keeps a plain key; the
// collected set and the payout record hold board positions, so they take the
// plane's key style.
const KEY_WALLET = 'infinite-maze.wallet';
const KEY_COINS = 'infinite-maze.plane.coins';
const KEY_PAID = 'infinite-maze.plane.coins.paid';
// The stacked world's save difficulty, which a plane save never reads.
const KEY_STACKED_SAVE_DIFFICULTY = 'infinite-maze.save.difficulty';
// A save code runs to 26 characters: 10 for the seed and up to 16 digits of p.
const TYPED_MAX = 26;

// Every storage access is guarded; the game runs without storage.
function load(key) {
  try { return globalThis.localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { globalThis.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function unstore(key) {
  try { globalThis.localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

const display = document.getElementById('screen');
const dctx = display.getContext('2d');
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

/** The stored save read at the difficulty that wrote it, or null. */
function readSave() {
  const difficulty = storedDifficulty(KEY_SAVE_DIFFICULTY, 'ultimate');
  const s = decodeSave(load(KEY_SAVE) || '');
  return s && { ...s, difficulty };
}

/** Stores a save of the current run with the run's difficulty. */
function writeSave(g, text) {
  store(KEY_SAVE, text);
  store(KEY_SAVE_DIFFICULTY, g.world.difficulty);
}

function present() {
  dctx.imageSmoothingEnabled = false;
  dctx.drawImage(view, 0, 0, display.width, display.height);
}

function rollCode() {
  const b = new Uint8Array(5);
  globalThis.crypto.getRandomValues(b);
  return codeFromBytes(b);
}

function snapCam(cam, sim) {
  const [x, y] = feet(sim);
  cam.x = x;
  cam.y = y + 18;
}

// Lerp toward a target held inside a deadzone around the view centre.
function followCam(cam, sim) {
  const [x, y] = feet(sim);
  const tx = x, ty = y + 18;
  let gx = cam.x, gy = cam.y;
  if (tx - cam.x > 20) gx = tx - 20; else if (cam.x - tx > 20) gx = tx + 20;
  if (ty - cam.y > 12) gy = ty - 12; else if (cam.y - ty > 12) gy = ty + 12;
  cam.x += (gx - cam.x) * 0.16;
  cam.y += (gy - cam.y) * 0.16;
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
    const r = createRenderer(view, world);
    const cam = { x: 0, y: 0 };
    snapCam(cam, sim);
    r.scene(sim, cam, 0);
    r.hud(sim);
    // Draws the pause screen over the scene, so a draw-time error fails the gate.
    drawPause({ renderer: r, world, sim, code: SELFTEST_CODE, copied: '', audio: { muted: false }, frame: frameOf(sim.bd, world.size), pauseMap: null, pausedAt: null });
    present();
    const px = view.getContext('2d').getImageData(0, 0, VIEW_W, VIEW_H).data;
    const colours = new Set();
    for (let i = 0; i < px.length && colours.size < 2; i += 4) colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (colours.size < 2) { finish('fail: canvas holds one colour'); return; }
    // The game's default level, MEDIUM, whose tomb (1, 0) starts at column 3.
    planeLeg(createWorld(SELFTEST_CODE, { difficulty: 'medium' }));
    touchLeg();
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
  // The inner 28x28 px of the explorer's 32 px room, in view pixels (y down).
  const [nx, ny] = nodeXY(sim.bd, sim.cell);
  const x0 = nx - 14 - Math.round(cam.x) + VIEW_W / 2, y0 = Math.round(cam.y) - (ny + 30) + VIEW_H / 2;
  const room = (wd) => {
    createRenderer(view, wd).scene(sim, cam, 0);
    return view.getContext('2d').getImageData(x0, y0, 28, 28).data;
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
  // The leg writes the save, its difficulty, the setting, the best score, the
  // stacked world's save difficulty, the coin keys and the pad's side; it
  // restores the player's own.
  const kept = [
    KEY_SAVE, KEY_SAVE_DIFFICULTY, KEY_DIFFICULTY, KEY_BEST, KEY_STACKED_SAVE_DIFFICULTY, KEY_WALLET, KEY_COINS, KEY_PAID,
    KEY_PAD,
  ].map((k) => [k, load(k)]);
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
    for (const [k, v] of kept) {
      if (v === null) unstore(k); else store(k, v);
    }
  }
  if (kept.some(([k, v]) => load(k) !== v)) throw new Error('touch storage restored');
  if (Object.getOwnPropertyDescriptor(navigator, 'clipboard')) throw new Error('touch clipboard restored');
  if (Object.getOwnPropertyDescriptor(navigator, 'getGamepads')) throw new Error('touch getGamepads restored');
}

/** `copied` records each clipboard write; writeText runs within the click. `fake.held` holds the fake gamepad's pressed buttons. */
function driveTouch(copied, fake) {
  const need = (ok, what) => { if (!ok) throw new Error(`touch ${what}`); };
  // Boot reads the player's setting; with none stored, a new player starts at MEDIUM.
  unstore(KEY_DIFFICULTY);
  // Boot reads the coin keys: a wallet of 7, one collected coin and a record that is not JSON.
  store(KEY_WALLET, '7');
  store(KEY_COINS, JSON.stringify({ [coinKey(SELFTEST_CODE, 'medium')]: ['0,0,21'] }));
  store(KEY_PAID, '{not json');
  // Boot reads the pad's side.
  store(KEY_PAD, 'right');
  const g = boot();
  need(g.wallet === 7 && (g.coins.get(coinKey(SELFTEST_CODE, 'medium')) || new Set()).has('0,0,21') && g.paid.size === 0,
    'boot reads the wallet and the collected set, and a malformed record as empty');
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
    const carry = { time: s.time, solved: s.solved, lastEntry: s.lastEntry };
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
  need(Math.abs(fx - Math.round(g.cam.x) + VIEW_W / 2 - wantX) <= 1 && Math.abs(Math.round(g.cam.y) - fy + VIEW_H / 2 - wantY) <= 1,
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
  // A save under another seed, so the title's save code differs from its seed code.
  store(KEY_SAVE, g.code === 'K7Q2M9XA' ? '0000-0000:13' : 'K7Q2-M9XA:13');
  const saved = decodeSave(load(KEY_SAVE));
  need(formatCode(saved.code) !== formatCode(g.code), 'the title shows a save under another seed');
  copies('title', `${formatCode(saved.code)}:${saved.p}`);
  const realPrompt = window.prompt;
  try {
    window.prompt = () => 'K7Q2-M9XA';
    click('title', 'type');
    need(g.code === 'K7Q2M9XA' && g.typing === null, 'TYPE CODE takes the answer');
    window.prompt = () => null;
    click('title', 'type');
    need(g.code === 'K7Q2M9XA' && g.typing === null, 'TYPE CODE cancel keeps the code and closes typing');
  } finally {
    window.prompt = realPrompt;
  }

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
  need(g.screen === 'pause' && load(KEY_SAVE) === hereCode(g), 'PAUSE reaches pause and stores a save');
  const home = frameOf(g.sim.bd, g.world.size);
  const framed = (du, dv) => sameFrame(g.frame, { u: home.u + du, v: home.v + dv });
  need(framed(0, 0), 'PAUSE frames the explorer\'s tomb');
  need(load(KEY_SAVE_DIFFICULTY) === g.world.difficulty, 'PAUSE stores the save\'s difficulty');
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
  coinLeg(g, { need, click });
  splashLeg(g, { need, click, press });
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

  // A save resumes at the difficulty that wrote it, with no run open, as at startup.
  const saveAt = (d) => {
    setDifficulty(g, d);
    click('title', 'begin');
    offEntry();
    click('play', 'pause');
    need(load(KEY_SAVE_DIFFICULTY) === d, `PAUSE stores ${difficultyLabel(d)} with the save`);
    const where = { x: g.sim.bd.x, y: g.sim.bd.y, sim: g.sim };
    click('pause', 'title');
    g.open = null;
    return where;
  };
  const resumesAt = (d, where) => {
    click('title', 'resume');
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
  // A save from before difficulties, with none stored beside it, plays at
  // ULTIMATE, the 6x4 world, whatever difficulty the stacked world's save left.
  const old = saveAt('ultimate');
  unstore(KEY_SAVE_DIFFICULTY);
  store(KEY_STACKED_SAVE_DIFFICULTY, 'easy');
  press('ArrowLeft', 'ArrowLeft');
  press('ArrowLeft', 'ArrowLeft');
  press('ArrowLeft', 'ArrowLeft');
  need(sized('easy'), 'the setting moves to EASY over a save with no difficulty');
  // A held P or Esc repeats; the title ignores the repeat, as it does Space's.
  press('KeyP', 'p', true);
  need(g.screen === 'title', 'the title ignores an auto-repeated P');
  press('Escape', 'Escape', true);
  need(g.screen === 'title', 'the title ignores an auto-repeated Esc');
  const sideNow = g.side;
  press('KeyH', 'h', true);
  need(g.side === sideNow && load(KEY_PAD) === sideNow, 'the title ignores an auto-repeated H');
  click('title', 'resume');
  need(g.screen === 'play' && sized('ultimate') && g.sim.bd.x === old.x && g.sim.bd.y === old.y, 'RESUME plays a save with no stored difficulty at ULTIMATE on its board');
  click('play', 'pause');
  click('pause', 'title');
  g.open = null;
  const easy = saveAt('easy');
  press('ArrowRight', 'ArrowRight');
  need(sized('medium'), 'the setting moves to MEDIUM over an EASY save');
  resumesAt('easy', easy);

  // RESET rolls a new seed and keeps the save.
  click('play', 'pause');
  click('pause', 'title');
  const save = [load(KEY_SAVE), load(KEY_SAVE_DIFFICULTY)], code = g.code;
  click('title', 'reset');
  need(g.code !== code && load(KEY_SAVE) === save[0] && load(KEY_SAVE_DIFFICULTY) === save[1], 'RESET changes the seed and keeps the save');

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

/**
 * Scores one tomb along the forward chain: starts a run on the game's world at
 * the first primary cell of tomb (0, 0)'s exit board, with `n` tombs below its
 * row already solved, and walks the exit to the downstream entry's flame until
 * the tomb count reaches n + 1. Throws `touch ...` when the walk takes a coin or
 * runs out of ticks. It returns the ticks run. With `doomAt` > 0, the torch is an
 * ember that goes out on that tick. It is the only coin code that names a run's
 * `solved` and `start`.
 */
function oneTombOn(g, n, doomAt = 0) {
  const { world } = g;
  const t = world.tomb(0, 0);
  const at = boardCoords(0, 0, t.X, world.size);
  const X = world.board(at.x, at.y);
  const chain = world.tombFlames(0, 0).chains[0];
  const solved = new Set(Array.from({ length: n }, (_, i) => `0,${-1 - i}`));
  begin(g, X.p, { time: 0, solved, lastEntry: X.p, trail: createTrail(), start: { u: 0, v: 0 } });
  const auto = createAutopilot(world, [chain[chain.length - 1]]);
  let taken = 0, ticks = 0;
  const drive = (s) => {
    if (++ticks === doomAt) { s.burn = 0; s.ember = TICK / 2; }
    return auto(s);
  };
  runTicks(g, drive, () => tombCount(g.sim) >= n + 1, 4000,
    `the walk out of tomb (0, 0) reaches tomb count ${n + 1}`, () => { if (g.sim.events.includes('coin')) taken++; });
  if (taken) throw new Error('touch the walk out of tomb (0, 0) takes no coin');
  return ticks;
}

/** Stores the wallet, the collected set and the payout record, as the game does on each change. */
function keepCoins(g) {
  store(KEY_WALLET, String(g.wallet));
  store(KEY_COINS, serializeCollected(g.coins));
  store(KEY_PAID, serializePaid(g.paid));
}

/** The first coin of tomb (0, 0), board by board in index order, as { bd, cell }, or null. */
function firstCoin(world) {
  for (let i = 0; i < world.size.w * world.size.h; i++) {
    const { x, y } = boardCoords(0, 0, i, world.size);
    const bd = world.board(x, y);
    const item = floorItems(world, bd).find((it) => it.kind === 'coin');
    if (item) return { bd, cell: item.cell };
  }
  return null;
}

/**
 * Walks the run to the dead-end cell of `item`, then toward its spot until the
 * feet come within 12 px of it, as the sim tests contact. `seen` runs after
 * each tick. Throws `touch ...` when the walk runs out of ticks.
 */
function walkToItem(g, { bd, cell }, seen = () => {}, what = 'coin') {
  const [sx, sy] = itemSpot(bd, cell);
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
  g.screen = 'title';
  draw(g, 0);
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
}

/** The coin steps of the touch leg, from the title with no run open. */
function coinLeg(g, { need, click }) {
  const rates = { easy: 1, medium: 2, hard: 5, ultimate: 10 };
  const onLevel = (d) => {
    setDifficulty(g, d);
    useCode(g, SELFTEST_CODE);
  };
  const clearCoins = () => {
    g.wallet = 0;
    g.coins = new Map();
    g.paid = new Map();
    keepCoins(g);
  };

  // Step 1: the first coin of tomb (0, 0) at MEDIUM.
  clearCoins();
  onLevel('medium');
  g.screen = 'title';
  draw(g, 0);
  click('title', 'begin');
  need(g.screen === 'play' && g.earned === 0, 'BEGIN starts a run with no coins earned');
  const coin = firstCoin(g.world);
  need(coin !== null, 'tomb (0, 0) holds a coin at MEDIUM');
  const key = coinKey(SELFTEST_CODE, 'medium'), id = coinId(coin.bd, coin.cell);
  walkToItem(g, coin);
  need(g.sim.events.includes('coin') && g.wallet === 1, 'touching the first coin adds one to the wallet');
  need(g.earned === 1, 'a coin counts as one earned this run');
  need(load(KEY_WALLET) === '1', 'a touched coin stores the wallet');
  need((JSON.parse(load(KEY_COINS))[key] || []).includes(id), 'a touched coin stores the collected set under the seed and level');

  // Step 2: a new run on the same seed and level.
  begin(g);
  walkToItem(g, coin);
  let held = 0;
  runTicks(g, () => [0, 0, false], () => held >= 30, 100, 'the explorer stands on the coin', () => { held++; });
  need(g.wallet === 1 && g.earned === 0, 'a collected coin credits nothing on a new run');
  need(g.coins.get(key).has(id), 'the collected set keeps the coin');

  // Step 3: a new best tomb pays its rate.
  for (const d of DIFFICULTIES) {
    onLevel(d);
    g.paid.delete(coinKey(SELFTEST_CODE, d));
    keepCoins(g);
    const was = g.wallet;
    oneTombOn(g, 0);
    need(g.wallet - was === rates[d], `a new best tomb pays ${rates[d]} at ${difficultyLabel(d)}`);
    need(load(KEY_WALLET) === String(g.wallet) && JSON.parse(load(KEY_PAID))[coinKey(SELFTEST_CODE, d)] === 1,
      `the ${difficultyLabel(d)} payout stores the wallet and the record`);
  }

  // Step 4: a replay pays only past the record.
  for (const d of DIFFICULTIES) {
    onLevel(d);
    g.paid.set(coinKey(SELFTEST_CODE, d), 1);
    keepCoins(g);
    const was = g.wallet;
    oneTombOn(g, 0);
    need(g.wallet === was, `a replay at the record pays nothing at ${difficultyLabel(d)}`);
    oneTombOn(g, 1);
    need(g.wallet - was === rates[d], `a tomb past the record pays ${rates[d]} once at ${difficultyLabel(d)}`);
    need(load(KEY_WALLET) === String(g.wallet) && JSON.parse(load(KEY_PAID))[coinKey(SELFTEST_CODE, d)] === 2,
      `the ${difficultyLabel(d)} replay stores the wallet and the record`);
  }

  // Step 5: the coins earned this run equal the wallet's gain since BEGIN.
  clearCoins();
  onLevel('medium');
  g.screen = 'title';
  draw(g, 0);
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
}

/**
 * The splash steps of the touch leg. `oneTombOn(g, 99)` crosses tomb 100
 * through the shipped tick, so each step reads the screen the game chose.
 */
function splashLeg(g, { need, click, press }) {

  // Step 1: the first crossing of tomb 100 shows TORCHBEARER and pays the rate plus 100, at every level.
  g.wallet = 0;
  g.coins = new Map();
  g.paid = new Map();
  for (const d of DIFFICULTIES) {
    setDifficulty(g, d);
    useCode(g, SELFTEST_CODE);
    const key = coinKey(SELFTEST_CODE, d), label = difficultyLabel(d);
    g.paid.set(key, 99);
    keepCoins(g);
    const was = g.wallet, earned = g.earned;
    oneTombOn(g, 99);
    need(g.screen === 'splash' && g.splash.k === 1 && rankName(g.splash.k) === 'TORCHBEARER' && g.splash.paid,
      `tomb 100 shows the splash with TORCHBEARER at ${label}`);
    need(g.wallet - was === COIN_RATE[d] + 100, `tomb 100 pays ${COIN_RATE[d]} plus 100 at ${label}`);
    need(g.earned - earned === g.wallet - was, `the milestone payout counts in the coins earned at ${label}`);
    need(load(KEY_WALLET) === String(g.wallet) && JSON.parse(load(KEY_PAID))[key] === 100,
      `the ${label} milestone payout stores the wallet and the record`);
    // The tick's entry event stores a save too, so the splash's own write shows only over a stale one.
    store(KEY_SAVE, 'stale');
    showSplash(g, g.splash.k, g.splash.paid);
    need(load(KEY_SAVE) === hereCode(g), `the ${label} splash stores the save`);
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
  oneTombOn(g, 99);
  need(g.screen === 'splash' && g.splash.k === 1 && !g.splash.paid, 'a second crossing of tomb 100 shows the splash');
  need(g.wallet === wallet, 'a second crossing of tomb 100 pays nothing');
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
  const ticks = oneTombOn(g, 99);
  const level = g.world.difficulty;
  g.paid.set(coinKey(SELFTEST_CODE, level), 99);
  const before = g.wallet;
  oneTombOn(g, 99, ticks);
  need(g.screen === 'over' && tombCount(g.sim) === 100, 'a run that ends on the crossing of tomb 100 shows the end screen');
  need(g.wallet - before === COIN_RATE[level] + 100, 'the payout stands when the run ends on the crossing of tomb 100');
  draw(g, 0);
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

/** The wallet, the collected set and the payout record as stored; absent or malformed reads as empty. */
function readCoinState() {
  return { wallet: parseWallet(load(KEY_WALLET)), coins: parseCollected(load(KEY_COINS)), paid: parsePaid(load(KEY_PAID)) };
}

/** The collected set of the game's seed and level, which a run's sim fills as it takes coins. */
function collectedSet(g) {
  const key = coinKey(g.code, g.world.difficulty);
  let set = g.coins.get(key);
  if (!set) {
    set = new Set();
    g.coins.set(key, set);
  }
  return set;
}

/** Adds n coins to the wallet and to the coins earned this run, and stores the wallet. */
function earn(g, n) {
  g.wallet += n;
  g.earned += n;
  store(KEY_WALLET, String(g.wallet));
}

/** A touched coin: the sim already holds its key in the collected set. */
function collectCoin(g) {
  earn(g, 1);
  store(KEY_COINS, serializeCollected(g.coins));
}

/** Pays the tombs the run has climbed past the highest count already paid on this seed and level. */
function payTombs(g) {
  const key = coinKey(g.code, g.world.difficulty);
  const record = g.paid.get(key) || 0;
  const count = tombCount(g.sim);
  const due = tombPayout(g.world.difficulty, record, count);
  if (due === 0) return;
  g.paid.set(key, count);
  earn(g, due);
  store(KEY_PAID, serializePaid(g.paid));
}

/** State shared by input, tick and draw. */
function createGame() {
  return {
    ...readCoinState(),
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
    screen: 'title', typing: null, note: '', footFrame: -1, climbFrame: -1,
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
  g.renderer = createRenderer(view, g.world);
  g.preview = createSim(g.world, g.world.startPoint(), null, { collected: collectedSet(g) });
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

/** Starts a new run at save position p, or at tomb (0, 0)'s first entry when p is null. */
function begin(g, p = null, carry = null) {
  let start = g.world.startPoint();
  if (p !== null) {
    const { x, y } = boardOfPos(p);
    start = g.world.resumePoint(x, y);
  }
  g.sim = createSim(g.world, start, carry, { collected: collectedSet(g) });
  if (!carry) g.earned = 0;
  g.open = null;
  play(g);
}

/**
 * RESUME: back to the open run unchanged, or with none open, the save rebuilt
 * at its own difficulty. Either way the setting follows the run.
 */
function resume(g) {
  const o = g.open;
  if (o) {
    g.open = null;
    Object.assign(g, { code: o.code, world: o.world, renderer: o.renderer, preview: o.preview, sim: o.sim });
    keepSetting(g, o.world.difficulty);
    play(g);
    return;
  }
  const s = readSave();
  if (!s) return;
  keepSetting(g, s.difficulty);
  if (s.code !== g.code || g.world.difficulty !== s.difficulty) useCode(g, s.code);
  begin(g, s.p);
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
    if (save.code !== g.code) useCode(g, save.code);
    g.typing = null;
    begin(g, save.p);
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

function titleKey(g, e) {
  if (g.typing !== null) { typingKey(g, e); return; }
  const at = DIFFICULTIES.indexOf(g.difficulty);
  if (e.key === 'Enter' || (e.code === 'Space' && !e.repeat)) begin(g);
  else if (e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }
  else if (e.code === 'KeyR') { useCode(g, rollCode()); g.note = ''; }
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
    copyWithStatus(globalThis.navigator.clipboard, shown, (status) => {
      if (g.screen === 'title') g.note = status;
    });
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
  g.open = { code: g.code, world: g.world, renderer: g.renderer, preview: g.preview, sim: g.sim };
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
    copyWithStatus(globalThis.navigator.clipboard, hereCode(g), (status) => {
      if (g.screen === 'pause') g.copied = status;
    });
  } else if (DIRS[e.code] && !e.repeat) g.frame = panFrame(g.frame, DIRS[e.code]);
}

function overKey(g, e) {
  const s = g.sim;
  if (e.key === 'Enter' || (e.code === 'Space' && !e.repeat)) {
    g.copied = '';
    begin(g, s.lastEntry, runCarry(s));
  } else if (e.code === 'KeyQ' || e.key === 'Escape') { g.screen = 'title'; g.copied = ''; titleCam(g); }
  else if (e.code === 'KeyC') {
    copyWithStatus(globalThis.navigator.clipboard, entryCode(g), (status) => {
      if (g.screen === 'over') g.copied = status;
    });
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
    if (ev === 'solved') { g.audio.play('band'); writeBest(g.code, g.world.difficulty, s.solved.size); }
    if (ev === 'entry') writeSave(g, entryCode(g));
    if (ev === 'coin') collectCoin(g);
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
 * The milestone a tick reached, as { k, paid }, or null; `was` is the tomb count
 * before the tick. Reads the payout record, so it runs before payTombs raises it.
 */
function milestoneHit(g, was) {
  const k = Math.floor(tombCount(g.sim) / MILESTONE);
  if (k <= Math.floor(was / MILESTONE)) return null;
  return { k, paid: (g.paid.get(coinKey(g.code, g.world.difficulty)) || 0) < k * MILESTONE };
}

function tick(g) {
  if (g.screen !== 'play') return;
  const was = tombCount(g.sim);
  stepSim(g);
  handleEvents(g);
  const hit = milestoneHit(g, was);
  payTombs(g);
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
  r.text('INFINITE MAZE', VIEW_W / 2, 18, 'm', { align: 'center', scale: 2 });
  r.text('A TOMB WITHOUT END', VIEW_W / 2, 38, 'a', { align: 'center' });
  r.panel(62, 50, 196, saved || g.typing !== null ? 100 : 88);
  r.text(`SEED  ${formatCode(g.code)}`, VIEW_W / 2, 58, 'i', { align: 'center' });
  if (g.typing !== null) {
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
    r.text(best === null ? 'NO TOMB REACHED YET' : `BEST TOMB  ${best}`, VIEW_W / 2, saved ? 136 : 124, 'p', { align: 'center' });
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
  r.text(saveLabel(g.copied), VIEW_W / 2, 108, 'a', { align: 'center' });
  r.text(`${entryCode(g)}  ${difficultyLabel(g.world.difficulty)}`, VIEW_W / 2, 120, 'i', { align: 'center' });
  r.text('ENTER CONTINUE  Q TITLE  C COPY', VIEW_W / 2, 138, 'b', { align: 'center' });
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
  present();
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

/** Fixed 60 Hz ticks, rendering once per animation frame. */
function runLoop(g) {
  let last = performance.now(), acc = 0;
  function frame(now) {
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    pollGamepads();
    while (acc >= TICK) { tick(g); acc -= TICK; }
    draw(g, now / 1000);
    requestAnimationFrame(frame);
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
      screen: g.screen, typing: g.typing !== null, muted: g.audio.muted, difficulty: g.difficulty, side: g.side,
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

if (location.hash === '#selftest') selftest();
else boot();
