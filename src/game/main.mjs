// Boot, input, the fixed 60 Hz loop and the title, play, pause and end
// screens. `#selftest` in the URL runs the self-test instead.
import { createWorld, boardOfPos } from '../world/world.mjs';
import { parseCode, formatCode, codeFromBytes } from '../world/hash.mjs';
import { encodeSave, decodeSave } from '../world/save.mjs';
import { createSim, step, runCarry, TICK, BURN_S, KEY, feet, pose } from './sim.mjs';
import { createRenderer, VIEW_W, VIEW_H, shade } from './render.mjs';
import { createAudio } from './audio.mjs';
import { runScript, SELFTEST_CODE } from './autopilot.mjs';
import { createTouch, layout, viewport } from './touch.mjs';
import { copyWithStatus, saveLabel } from './clipboard.mjs';
import { frameOf, panFrame, mapModel } from './map.mjs';
import { RGB, idx } from './art.mjs';

const KEY_SAVE = 'infinite-maze.save';
const KEY_BEST = 'infinite-maze.best';

// Every storage access is guarded; the game runs without storage.
function load(key) {
  try { return globalThis.localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { globalThis.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
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
    drawPause({ renderer: r, world, sim, code: SELFTEST_CODE, copied: '', audio: { muted: false }, frame: frameOf(sim.bd), pauseMap: null, pausedAt: null });
    present();
    const px = view.getContext('2d').getImageData(0, 0, VIEW_W, VIEW_H).data;
    const colours = new Set();
    for (let i = 0; i < px.length && colours.size < 2; i += 4) colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (colours.size < 2) { finish('fail: canvas holds one colour'); return; }
    touchLeg();
    // The verdict waits one task, so queued error and rejection events count.
    setTimeout(() => finish(errors.length ? `fail: ${errors[0]}` : 'pass'), 0);
  } catch (e) {
    finish(`fail: ${e && e.message ? e.message : e}`);
  }
}

/**
 * Boots the game and drives the real controls with dispatched touch pointer
 * events and clicks. One synchronous task: an animation frame landing
 * mid-leg would tick play and clear the press edges the leg reads. Throws
 * `touch <what>` on the first miss.
 */
function touchLeg() {
  // The leg writes the save and best band; it restores the player's own.
  const kept = [KEY_SAVE, KEY_BEST].map((k) => [k, load(k)]);
  // COPY writes through a fake clipboard, gone again however the leg ends.
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  try {
    driveTouch(copied);
  } finally {
    delete navigator.clipboard;
    for (const [k, v] of kept) {
      try { if (v === null) globalThis.localStorage.removeItem(k); else store(k, v); } catch { /* storage unavailable */ }
    }
  }
  if (kept.some(([k, v]) => load(k) !== v)) throw new Error('touch storage restored');
  if (Object.getOwnPropertyDescriptor(navigator, 'clipboard')) throw new Error('touch clipboard restored');
}

/** `copied` records each clipboard write; writeText runs within the click. */
function driveTouch(copied) {
  const need = (ok, what) => { if (!ok) throw new Error(`touch ${what}`); };
  const g = boot();
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
  // Another tree board of the explorer's band, keeping its last entry, so the
  // pause screen's save code and the end screen's entry code differ.
  const offEntry = () => {
    const s = g.sim, b = s.bd.band;
    const carry = { time: s.time, startBand: s.startBand, maxBand: s.maxBand, lastEntry: s.lastEntry };
    for (let i = 0; i < 24; i++) {
      const bd = g.world.board(i % 6, 4 * b + Math.floor(i / 6));
      if (!bd.links || bd.routeIndex === 0 || bd === s.bd || bd.p === s.lastEntry) continue;
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
  need(display.width === lay.backing.w && display.height === lay.backing.h, 'canvas backing size follows the layout');
  // Layout rounds to 1/64 CSS px, so the laid-out box matches within that.
  const box = display.getBoundingClientRect();
  need(Math.abs(box.width - lay.view.w) <= 1 / 64 && Math.abs(box.height - lay.view.h) <= 1 / 64, 'canvas CSS size follows the layout');

  // Title.
  const rolled = g.code;
  click('title', 'roll');
  need(g.code !== rolled, 'NEW ROLL changes the code');
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
  need(g.jump, 'the centre jumps');
  pointer('pointerup', pad, cx, cy);
  g.press = 0;
  g.release = 0;
  g.jump = false;

  // Pause.
  offEntry();
  click('play', 'pause');
  need(g.screen === 'pause' && load(KEY_SAVE) === hereCode(g), 'PAUSE reaches pause and stores a save');
  need(g.frame === g.sim.bd.band, 'PAUSE frames the explorer\'s band');
  press('ArrowUp', 'ArrowUp');
  need(g.frame === g.sim.bd.band + 1, 'Up pans one band up');
  press('ArrowUp', 'ArrowUp', true);
  press('ArrowLeft', 'ArrowLeft');
  need(g.frame === g.sim.bd.band + 1, 'a held Up and a Left pan nothing');
  press('KeyS', 's');
  need(g.frame === g.sim.bd.band, 'S pans one band down');
  toggles('pause');
  copies('pause', hereCode(g));
  const before = pauseModel(g).explorer;
  // A pan before RESUME must not outlast the pause.
  press('ArrowUp', 'ArrowUp');
  click('pause', 'resume');
  need(g.screen === 'play', 'RESUME returns to play');
  // Walk to another cell of the band, so a map kept from the last pause shows the old one.
  const band = g.sim.bd.band, cell = g.sim.cell, bd = g.sim.bd;
  for (const [h, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let i = 0; i < 600 && g.sim.cell === cell && g.sim.bd === bd; i++) step(g.sim, h, v);
    if (g.sim.cell !== cell || g.sim.bd !== bd) break;
  }
  need(g.sim.bd.band === band && (g.sim.cell !== cell || g.sim.bd !== bd), 'the explorer walks to another cell of its band');
  click('play', 'pause');
  need(g.frame === frameOf(g.sim.bd), 'PAUSE frames the explorer\'s band again');
  const after = pauseModel(g).explorer;
  need(after && (!before || after.col !== before.col || after.row !== before.row), 'PAUSE draws the explorer where it now stands');
  click('pause', 'title');
  need(g.screen === 'title', 'TITLE reaches the title');

  // Continue.
  click('title', 'continue');
  need(g.screen === 'play', 'CONTINUE reaches play');

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

  // Leave the self-test script's run paused on screen for the screenshot.
  useCode(g, SELFTEST_CODE);
  g.sim = runScript(g.world).sim;
  snapCam(g.cam, g.sim);
  g.screen = 'play';
  g.keys.clear();
  press('Escape', 'Escape');
  need(g.screen === 'pause' && g.frame === frameOf(g.sim.bd), 'Esc pauses on the explorer\'s band');
  // The first pause frame lands half a second into the page and shows the explorer's dot.
  draw(g, 0.5);
  const e = pauseModel(g).explorer;
  const dot = view.getContext('2d').getImageData(52 + e.col * 3 + 1, 28 + (27 - e.row) * 3 + 1, 1, 1).data;
  need(RGB[idx('p')].every((v, i) => dot[i] === v), 'the pause map shows the explorer first');
}

const DIRS = {
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
};
const DIR_BITS = { l: KEY.L, r: KEY.R, u: KEY.U, d: KEY.D };
const JUMP_KEYS = ['Space', 'KeyZ'];

function readBest(code) {
  try { return JSON.parse(load(KEY_BEST) || '{}')[code] ?? null; } catch { return null; }
}

function writeBest(code, band) {
  let all = {};
  try { all = JSON.parse(load(KEY_BEST) || '{}'); } catch { all = {}; }
  if (all[code] === undefined || band > all[code]) { all[code] = band; store(KEY_BEST, JSON.stringify(all)); }
}

/** State shared by input, tick and draw. */
function createGame() {
  return {
    audio: createAudio(), keys: new Set(), cam: { x: 0, y: 0 },
    // Key edges since the last tick: KEY bits pressed and released, and a jump press.
    press: 0, release: 0, jump: false,
    code: parseCode((decodeSave(load(KEY_SAVE) || '') || {}).code || '') || rollCode(),
    world: null, renderer: null, sim: null, preview: null,
    screen: 'title', typing: null, note: '', footFrame: -1, climbFrame: -1,
    // The band the pause map frames, and its model.
    frame: 0, pauseMap: null, pausedAt: null,
  };
}

// Title camera: the explorer stands 118 px left of the view centre, clear of the menu panel.
function titleCam(g) {
  snapCam(g.cam, g.preview);
  g.cam.x += 118;
}

function useCode(g, code) {
  g.code = code;
  g.world = createWorld(code);
  g.renderer = createRenderer(view, g.world);
  g.preview = createSim(g.world, g.world.resumePoint(g.world.tree(0).entryX, 0));
  titleCam(g);
}

/** Starts a run at save position p, or at band 0's entry when p is null. */
function begin(g, p = null, carry = null) {
  const at = p === null ? { x: g.world.tree(0).entryX, y: 0 } : boardOfPos(p);
  g.sim = createSim(g.world, g.world.resumePoint(at.x, at.y), carry);
  snapCam(g.cam, g.sim);
  g.screen = 'play';
  g.note = '';
  g.press = 0;
  g.release = 0;
  g.jump = false;
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
  else if (/^[0-9A-Za-z:\-]$/.test(e.key) && g.typing.length < 22) g.typing += e.key.toUpperCase();
}

function titleKey(g, e) {
  if (g.typing !== null) { typingKey(g, e); return; }
  if (e.key === 'Enter' || (e.code === 'Space' && !e.repeat)) begin(g);
  else if (e.code === 'KeyR') { useCode(g, rollCode()); g.note = ''; }
  else if (e.code === 'KeyT') { g.typing = ''; g.note = ''; }
  else if (e.code === 'KeyC') {
    const s = decodeSave(load(KEY_SAVE) || '');
    if (s) { if (s.code !== g.code) useCode(g, s.code); begin(g, s.p); }
  } else if (e.code === 'KeyK') {
    // The save code the title shows, or the seed code when it shows none.
    const s = decodeSave(load(KEY_SAVE) || '');
    const shown = s ? `${formatCode(s.code)}:${s.p}` : formatCode(g.code);
    copyWithStatus(globalThis.navigator.clipboard, shown, (status) => {
      if (g.screen === 'title') g.note = status;
    });
  }
}

function playKey(g, e) {
  if (e.key === 'Escape') {
    g.screen = 'pause';
    g.frame = frameOf(g.sim.bd);
    g.pauseMap = null;
    g.pausedAt = null;
    store(KEY_SAVE, hereCode(g));
    return;
  }
  if (DIRS[e.code]) {
    g.keys.add(DIRS[e.code]);
    if (!e.repeat) g.press |= DIR_BITS[DIRS[e.code]];
  }
  if (JUMP_KEYS.includes(e.code) && !e.repeat) g.jump = true;
}

// g.copied: the copy status the pause or end screen shows, cleared on leaving it.
function pauseKey(g, e) {
  if (e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }
  else if (e.code === 'KeyQ') { g.screen = 'title'; g.copied = ''; titleCam(g); }
  else if (e.code === 'KeyC') {
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

const SCREEN_KEYS = { title: titleKey, play: playKey, pause: pauseKey, over: overKey };

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
    else if (ev === 'ember' || ev === 'over' || ev === 'band') g.audio.play(ev);
    if (ev === 'band') writeBest(g.code, s.maxBand);
    if (ev === 'entry') store(KEY_SAVE, entryCode(g));
    if (ev === 'seam') g.world.retain(s.bd.band - 1, s.bd.band + 1);
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
  writeBest(g.code, g.sim.maxBand);
  store(KEY_SAVE, entryCode(g));
}

function tick(g) {
  if (g.screen !== 'play') return;
  stepSim(g);
  handleEvents(g);
  soundCues(g);
  followCam(g.cam, g.sim);
  if (g.sim.state === 'over') endRun(g);
}

function drawTitle(g, t) {
  const r = g.renderer;
  r.scene(g.preview, g.cam, t);
  const saved = decodeSave(load(KEY_SAVE) || '');
  const best = readBest(g.code);
  r.ctx.fillStyle = shade(0.45);
  r.ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  r.text('INFINITE MAZE', VIEW_W / 2, 18, 'm', { align: 'center', scale: 2 });
  r.text('A TOMB WITHOUT END', VIEW_W / 2, 38, 'a', { align: 'center' });
  r.panel(62, 54, 196, saved ? 92 : 82);
  r.text(`SEED  ${formatCode(g.code)}`, VIEW_W / 2, 62, 'i', { align: 'center' });
  if (g.typing !== null) {
    r.text(`CODE  ${g.typing}${Math.floor(t * 2) % 2 ? '_' : ' '}`, 72, 80, 'c');
    r.text('ENTER  ACCEPT', 72, 96, 'b');
    r.text('ESC    CANCEL', 72, 108, 'b');
    r.text('SEED  XXXX-XXXX', 72, 124, '9');
    r.text('SAVE  XXXX-XXXX:P', 72, 134, '9');
  } else {
    r.text('ENTER  BEGIN', 72, 80, 'c');
    r.text('R      NEW ROLL', 72, 92, 'b');
    r.text('K COPY', 248, 92, 'b', { align: 'right' });
    r.text('T      TYPE A CODE', 72, 104, 'b');
    if (saved) r.text(`C      ${formatCode(saved.code)}:${saved.p}`, 72, 116, 'b');
    r.text(best === null ? 'NO TOMB REACHED YET' : `BEST TOMB  ${best}`, VIEW_W / 2, saved ? 132 : 120, 'p', { align: 'center' });
  }
  if (g.note) r.text(g.note, VIEW_W / 2, 152, 'o', { align: 'center' });
  r.text(touch && touch.on ? 'D-PAD MOVE  CENTRE JUMP' : 'ARROWS/WASD MOVE  SPACE/Z JUMP  M MUTE  ESC PAUSE', VIEW_W / 2, 166, '9', { align: 'center' });
}

/** The pause map's model for the frame, rebuilt when the frame changes. */
function pauseModel(g) {
  if (!g.pauseMap || g.pauseMap.b !== g.frame) {
    const at = { bd: g.sim.bd, cell: g.sim.cell };
    g.pauseMap = { b: g.frame, model: mapModel(g.world, g.sim.trail, g.frame, at) };
  }
  return g.pauseMap.model;
}

// The panel spans y 2..177; its rules leave y 5..174 for rows at least 4 px apart.
function drawPause(g, t = 0) {
  const r = g.renderer;
  r.panel(50, 2, 220, 176);
  r.text('PAUSED', VIEW_W / 2, 9, 'm', { align: 'center', scale: 2 });
  r.text(`TOMB ${g.frame}`, 267, 16, 'a', { align: 'right' });
  if (g.pausedAt === null) g.pausedAt = t;
  r.drawMap(pauseModel(g), 52, 28, t - g.pausedAt);
  r.text(saveLabel(g.copied), VIEW_W / 2, 118, 'a', { align: 'center' });
  r.text(hereCode(g), VIEW_W / 2, 129, 'i', { align: 'center' });
  r.text(g.audio.muted ? 'SOUND OFF' : 'SOUND ON', VIEW_W / 2, 141, '9', { align: 'center' });
  r.text('ESC RESUME  UP/DOWN PAN  Q TITLE', VIEW_W / 2, 153, 'b', { align: 'center' });
  r.text('M MUTE  C COPY', VIEW_W / 2, 164, 'b', { align: 'center' });
}

function drawOver(g) {
  const r = g.renderer, s = g.sim;
  r.panel(40, 34, 240, 112);
  r.text('THE TORCH IS OUT', VIEW_W / 2, 44, 'o', { align: 'center', scale: 2 });
  r.text(`TOMBS CLIMBED  ${s.maxBand - s.startBand}`, VIEW_W / 2, 68, 'c', { align: 'center' });
  r.text(`TIME  ${clock(s.time)}`, VIEW_W / 2, 80, 'c', { align: 'center' });
  r.text(saveLabel(g.copied), VIEW_W / 2, 96, 'a', { align: 'center' });
  r.text(entryCode(g), VIEW_W / 2, 108, 'i', { align: 'center' });
  r.text('ENTER CONTINUE  Q TITLE  C COPY', VIEW_W / 2, 126, 'b', { align: 'center' });
}

function draw(g, t) {
  if (g.screen === 'title') {
    drawTitle(g, t);
  } else {
    g.renderer.scene(g.sim, g.cam, t);
    g.renderer.hud(g.sim);
    if (g.screen === 'pause') drawPause(g, t);
    else if (g.screen === 'over') drawOver(g);
  }
  present();
  if (touch) touch.refresh();
}

/** Fixed 60 Hz ticks, rendering once per animation frame. */
function runLoop(g) {
  let last = performance.now(), acc = 0;
  function frame(now) {
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    while (acc >= TICK) { tick(g); acc -= TICK; }
    draw(g, now / 1000);
    requestAnimationFrame(frame);
  }
  draw(g, 0);
  requestAnimationFrame(frame);
}

function boot() {
  const g = createGame();
  touch = createTouch({
    state: () => ({
      screen: g.screen, typing: g.typing !== null, muted: g.audio.muted,
      save: g.screen === 'title' && Boolean(decodeSave(load(KEY_SAVE) || '')),
    }),
    onMode: fit,
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
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  fit();
  useCode(g, g.code);
  runLoop(g);
  return g;
}

if (location.hash === '#selftest') selftest();
else boot();
