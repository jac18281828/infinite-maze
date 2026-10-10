// Boot, input, the fixed 60 Hz loop and the title, play, pause and end
// screens. `#selftest` in the URL runs the self-test instead.
import { createWorld, boardOfPos } from '../world/world.mjs';
import { parseCode, formatCode, codeFromBytes } from '../world/hash.mjs';
import { encodeSave, decodeSave } from '../world/save.mjs';
import { createSim, step, TICK, BURN_S, feet, pose } from './sim.mjs';
import { createRenderer, VIEW_W, VIEW_H, shade } from './render.mjs';
import { createAudio } from './audio.mjs';
import { runScript, SELFTEST_CODE } from './autopilot.mjs';

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

function fit() {
  const k = Math.max(1, Math.floor(Math.min(innerWidth / VIEW_W, innerHeight / VIEW_H)));
  display.width = VIEW_W * k;
  display.height = VIEW_H * k;
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
    present();
    const px = view.getContext('2d').getImageData(0, 0, VIEW_W, VIEW_H).data;
    const colours = new Set();
    for (let i = 0; i < px.length && colours.size < 2; i += 4) colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (colours.size < 2) { finish('fail: canvas holds one colour'); return; }
    // The verdict waits one task, so queued error and rejection events count.
    setTimeout(() => finish(errors.length ? `fail: ${errors[0]}` : 'pass'), 0);
  } catch (e) {
    finish(`fail: ${e && e.message ? e.message : e}`);
  }
}

const DIRS = {
  ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
};

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
    code: parseCode((decodeSave(load(KEY_SAVE) || '') || {}).code || '') || rollCode(),
    world: null, renderer: null, sim: null, preview: null,
    screen: 'title', typing: null, note: '', footFrame: -1, climbFrame: -1,
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
  if (e.key === 'Enter' || e.code === 'Space') begin(g);
  else if (e.code === 'KeyR') useCode(g, rollCode());
  else if (e.code === 'KeyT') { g.typing = ''; g.note = ''; }
  else if (e.code === 'KeyC') {
    const s = decodeSave(load(KEY_SAVE) || '');
    if (s) { if (s.code !== g.code) useCode(g, s.code); begin(g, s.p); }
  }
}

function playKey(g, e) {
  if (e.key === 'Escape') { g.screen = 'pause'; store(KEY_SAVE, hereCode(g)); return; }
  if (DIRS[e.code]) g.keys.add(DIRS[e.code]);
}

function pauseKey(g, e) {
  if (e.key === 'Escape') g.screen = 'play';
  else if (e.code === 'KeyQ') { g.screen = 'title'; titleCam(g); }
}

function overKey(g, e) {
  const s = g.sim;
  if (e.key === 'Enter' || e.code === 'Space') {
    begin(g, s.lastEntry, { time: s.time, startBand: s.startBand, maxBand: s.maxBand, lastEntry: s.lastEntry });
  } else if (e.code === 'KeyQ' || e.key === 'Escape') { g.screen = 'title'; titleCam(g); }
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
  step(g.sim, h, v);
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
    r.text('T      TYPE A CODE', 72, 104, 'b');
    if (saved) r.text(`C      ${formatCode(saved.code)}:${saved.p}`, 72, 116, 'b');
    r.text(best === null ? 'NO BAND REACHED YET' : `BEST BAND  ${best}`, VIEW_W / 2, saved ? 132 : 120, 'p', { align: 'center' });
  }
  if (g.note) r.text(g.note, VIEW_W / 2, 152, 'o', { align: 'center' });
  r.text('ARROWS OR WASD MOVE  M MUTE  ESC PAUSE', VIEW_W / 2, 166, '9', { align: 'center' });
}

function drawPause(g) {
  const r = g.renderer;
  r.panel(50, 44, 220, 92);
  r.text('PAUSED', VIEW_W / 2, 54, 'm', { align: 'center', scale: 2 });
  r.text('SAVE CODE', VIEW_W / 2, 78, 'a', { align: 'center' });
  r.text(hereCode(g), VIEW_W / 2, 90, 'i', { align: 'center' });
  r.text(g.audio.muted ? 'SOUND OFF' : 'SOUND ON', VIEW_W / 2, 104, '9', { align: 'center' });
  r.text('ESC RESUME  M MUTE  Q TITLE', VIEW_W / 2, 120, 'b', { align: 'center' });
}

function drawOver(g) {
  const r = g.renderer, s = g.sim;
  r.panel(40, 34, 240, 112);
  r.text('THE TORCH IS OUT', VIEW_W / 2, 44, 'o', { align: 'center', scale: 2 });
  r.text(`BANDS CLIMBED  ${s.maxBand - s.startBand}`, VIEW_W / 2, 68, 'c', { align: 'center' });
  r.text(`TIME  ${clock(s.time)}`, VIEW_W / 2, 80, 'c', { align: 'center' });
  r.text('SAVE CODE', VIEW_W / 2, 96, 'a', { align: 'center' });
  r.text(entryCode(g), VIEW_W / 2, 108, 'i', { align: 'center' });
  r.text('ENTER CONTINUE  Q TITLE', VIEW_W / 2, 126, 'b', { align: 'center' });
}

function draw(g, t) {
  if (g.screen === 'title') {
    drawTitle(g, t);
  } else {
    g.renderer.scene(g.sim, g.cam, t);
    g.renderer.hud(g.sim);
    if (g.screen === 'pause') drawPause(g);
    else if (g.screen === 'over') drawOver(g);
  }
  present();
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
  window.addEventListener('keydown', (e) => onKeyDown(g, e));
  window.addEventListener('keyup', (e) => { if (DIRS[e.code]) g.keys.delete(DIRS[e.code]); });
  window.addEventListener('blur', () => g.keys.clear());
  window.addEventListener('resize', fit);
  fit();
  useCode(g, g.code);
  runLoop(g);
}

if (location.hash === '#selftest') selftest();
else boot();
