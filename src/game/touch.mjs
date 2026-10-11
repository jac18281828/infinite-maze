// Touch layer. Every control feeds the keyboard's own path: it dispatches
// keydown and keyup KeyboardEvents on window, so the key handlers, the held
// Up, the jump edge and the tap buffer serve touch unchanged.
// The first half is pure (layout, pad mapping, pointer bookkeeping, mode
// rules) and imports without a DOM; the second half binds it to the page.
import { FONT, FONT_W, FONT_H, PALETTE, RGB } from './art.mjs';
import { VIEW_W, VIEW_H } from './render.mjs';

export const MARGIN = 16;
export const PAD_MAX = 160;
export const PAD_FRAC = 0.42;
const GAP = 8;
const KEY_H = 44;
const KEY_MIN_W = 44;
const DOUBLE_TAP_MS = 350;

const mid = (a, size, inner) => a + (size - inner) / 2;

/**
 * Where the view, the d-pad and the soft-key areas go. Keyboard mode scales
 * by the largest whole multiple of CSS pixels. Touch mode fills the safe
 * area at a fractional scale: 'band' puts the view at the top with the
 * controls below; 'overlay' fits the view and floats the controls over it.
 * The backing store is in device pixels and the CSS size is backing / dpr.
 */
export function layout({ w, h, dpr = 1, insets = {}, touch }) {
  if (!touch) {
    const k = Math.max(1, Math.floor(Math.min(w / VIEW_W, h / VIEW_H)));
    const vw = VIEW_W * k, vh = VIEW_H * k;
    return {
      mode: 'keyboard', scale: k, D: 0, pad: null, band: null,
      safe: { x: 0, y: 0, w, h },
      view: { x: Math.floor((w - vw) / 2), y: Math.floor((h - vh) / 2), w: vw, h: vh },
      backing: { w: vw, h: vh },
    };
  }
  const safe = {
    x: insets.left || 0, y: insets.top || 0,
    w: w - (insets.left || 0) - (insets.right || 0), h: h - (insets.top || 0) - (insets.bottom || 0),
  };
  const D = Math.max(0, Math.min(PAD_MAX, Math.floor(PAD_FRAC * Math.min(safe.w, safe.h))));
  const band = safe.h - (safe.w * VIEW_H) / VIEW_W >= D + 2 * MARGIN;
  let bw, bh;
  if (band || safe.w / VIEW_W <= safe.h / VIEW_H) {
    bw = Math.max(1, Math.round(safe.w * dpr));
    bh = Math.max(1, Math.round((bw * VIEW_H) / VIEW_W));
  } else {
    bh = Math.max(1, Math.round(safe.h * dpr));
    bw = Math.max(1, Math.round((bh * VIEW_W) / VIEW_H));
  }
  const vw = bw / dpr, vh = bh / dpr;
  const snap = (v) => Math.round(v * dpr) / dpr;
  const vx = snap(mid(safe.x, safe.w, vw));
  if (band) {
    const rest = { x: safe.x, y: safe.y + vh, w: safe.w, h: safe.h - vh };
    return {
      mode: 'band', D, safe, band: rest, scale: vw / VIEW_W,
      view: { x: vx, y: safe.y, w: vw, h: vh }, backing: { w: bw, h: bh },
      pad: { x: mid(rest.x, rest.w, D), y: mid(rest.y, rest.h, D), s: D },
    };
  }
  return {
    mode: 'overlay', D, safe, band: null, scale: vw / VIEW_W,
    view: { x: vx, y: snap(mid(safe.y, safe.h, vh)), w: vw, h: vh }, backing: { w: bw, h: bh },
    pad: { x: safe.x + MARGIN, y: safe.y + safe.h - MARGIN - D, s: D },
  };
}

/** Next touch mode after an input event. */
export function nextTouchMode(on, ev) {
  if (ev.type === 'pointerdown' && ev.pointerType === 'touch') return true;
  if (ev.type === 'keydown' && ev.isTrusted === true) return false;
  return on;
}

/** Touch mode at boot. */
export function touchAtBoot({ maxTouchPoints = 0, coarse = false, hash = '' }) {
  return maxTouchPoints > 0 || coarse || hash === '#touch';
}

/** The pad zone of an offset from its centre: 'c' (jump) or an arm 'l', 'r', 'u', 'd'. */
export function padZone(dx, dy, D) {
  if (dx * dx + dy * dy <= (D / 6) * (D / 6)) return 'c';
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'l' : 'r';
  return dy < 0 ? 'u' : 'd';
}

const ARM_KEYS = {
  l: { code: 'ArrowLeft', key: 'ArrowLeft' }, r: { code: 'ArrowRight', key: 'ArrowRight' },
  u: { code: 'ArrowUp', key: 'ArrowUp' }, d: { code: 'ArrowDown', key: 'ArrowDown' },
};
const SPACE = { code: 'Space', key: ' ' };

/**
 * Pointer bookkeeping for the pad. Each call returns the key events to send,
 * as { type: 'keydown' | 'keyup', code, key }. A direction is down while any
 * pointer holds it.
 */
export function createPad() {
  const zones = new Map();
  const holders = { l: new Set(), r: new Set(), u: new Set(), d: new Set() };
  const op = (type, k) => ({ type, code: k.code, key: k.key });

  function grab(id, zone, out) {
    zones.set(id, zone);
    if (zone === 'c') return;
    holders[zone].add(id);
    if (holders[zone].size === 1) out.push(op('keydown', ARM_KEYS[zone]));
  }
  function drop(id, out) {
    const zone = zones.get(id);
    zones.delete(id);
    if (!zone || zone === 'c') return;
    holders[zone].delete(id);
    if (holders[zone].size === 0) out.push(op('keyup', ARM_KEYS[zone]));
  }

  return {
    down(id, dx, dy, D) {
      const out = [];
      drop(id, out);
      const zone = padZone(dx, dy, D);
      grab(id, zone, out);
      if (zone === 'c') out.push(op('keydown', SPACE), op('keyup', SPACE));
      return out;
    },
    move(id, dx, dy, D) {
      const out = [];
      if (!zones.has(id)) return out;
      const zone = padZone(dx, dy, D);
      if (zone === zones.get(id)) return out;
      drop(id, out);
      grab(id, zone, out);
      return out;
    },
    up(id) {
      const out = [];
      drop(id, out);
      return out;
    },
    releaseAll() {
      const out = [];
      for (const id of [...zones.keys()]) drop(id, out);
      return out;
    },
    has: (id) => zones.has(id),
    held: () => new Set(Object.keys(holders).filter((z) => holders[z].size > 0)),
    centre: () => [...zones.values()].includes('c'),
  };
}

const K = (code, key) => ({ code, key });
/**
 * Soft keys per screen, each a key that screen's handler accepts. `when`
 * gates a key on the game's state; `alt` is its label when muted; a key with
 * `setting` reads the difficulty setting as its label.
 */
export const SOFT = {
  title: [
    { id: 'resume', label: 'RESUME', ...K('Escape', 'Escape'), when: 'resume' },
    { id: 'begin', label: 'BEGIN', ...K('Enter', 'Enter') },
    { id: 'reset', label: 'RESET', ...K('KeyR', 'r') },
    { id: 'type', label: 'TYPE CODE', act: 'type' },
    { id: 'difficulty', label: 'MEDIUM', setting: true, ...K('KeyL', 'l') },
    { id: 'copy', label: 'COPY', ...K('KeyK', 'k') },
    { id: 'sound', label: 'SOUND', alt: 'MUTED', ...K('KeyM', 'm') },
  ],
  typing: [
    { id: 'accept', label: 'ACCEPT', ...K('Enter', 'Enter') },
    { id: 'cancel', label: 'CANCEL', ...K('Escape', 'Escape') },
  ],
  play: [
    { id: 'pause', label: 'PAUSE', ...K('Escape', 'Escape') },
  ],
  pause: [
    { id: 'resume', label: 'RESUME', ...K('Escape', 'Escape') },
    { id: 'copy', label: 'COPY', ...K('KeyC', 'c') },
    { id: 'sound', label: 'SOUND', alt: 'MUTED', ...K('KeyM', 'm') },
    { id: 'title', label: 'TITLE', ...K('KeyQ', 'q') },
  ],
  over: [
    { id: 'continue', label: 'CONTINUE', ...K('Enter', 'Enter') },
    { id: 'copy', label: 'COPY', ...K('KeyC', 'c') },
    { id: 'title', label: 'TITLE', ...K('KeyQ', 'q') },
  ],
};

/** The table row for the game's state: 'typing' is the title with its field open. */
export function screenId({ screen, typing }) {
  return screen === 'title' && typing ? 'typing' : screen;
}

/** The on-screen name of a difficulty: 'easy' reads EASY. */
export function difficultyLabel(difficulty) {
  return difficulty.toUpperCase();
}

/** The soft keys shown for a game state, with labels resolved. */
export function softKeys(state) {
  const text = (k) => (k.setting && state.difficulty ? difficultyLabel(state.difficulty) : state.muted && k.alt ? k.alt : k.label);
  return (SOFT[screenId(state)] || [])
    .filter((k) => !k.when || state[k.when])
    .map((k) => ({ ...k, text: text(k) }));
}

export function textWidth(str) {
  return str.length * (FONT_W + 1) - 1;
}

// Horizontal extent of each screen's panel in view pixels (the r.panel calls
// in main.mjs). Overlay-mode keys stay in the strips outside it, so they
// never cover the panel, the title's note line or its footer.
export const PANEL_X = { title: [62, 258], typing: [62, 258], pause: [50, 270], over: [40, 280] };

function keyRegion(lay, sid) {
  const { safe } = lay;
  if (lay.mode === 'band') {
    if (sid === 'play') {
      const x = lay.pad.x + lay.pad.s + GAP;
      return { x, y: lay.band.y + GAP, w: safe.x + safe.w - GAP - x, h: lay.band.h - 2 * GAP, cap: 96, align: 'start' };
    }
    return { x: lay.band.x + MARGIN, y: lay.band.y + GAP, w: lay.band.w - 2 * MARGIN, h: lay.band.h - 2 * GAP, cap: 240, align: 'center' };
  }
  if (sid === 'play') {
    return { x: safe.x + safe.w - GAP - 96, y: safe.y + GAP, w: 96, h: safe.h - 2 * GAP, cap: 96, align: 'end' };
  }
  const [px0, px1] = PANEL_X[sid];
  const left = { x: safe.x + GAP, w: lay.view.x + px0 * lay.scale - GAP - (safe.x + GAP) };
  const right = { x: lay.view.x + px1 * lay.scale + GAP, w: safe.x + safe.w - GAP - (lay.view.x + px1 * lay.scale + GAP) };
  const side = right.w >= left.w ? right : left;
  return { x: side.x, y: safe.y + GAP, w: side.w, h: safe.h - 2 * GAP, cap: 140, align: 'center' };
}

/**
 * Rectangles for the soft keys of screen `sid`, one per label, in order.
 * Each carries one label scale (3, 2 or 1), the largest that fits every label.
 */
export function keyRects(lay, sid, labels) {
  const n = labels.length;
  if (n === 0 || lay.mode === 'keyboard') return [];
  const r = keyRegion(lay, sid);
  const fits = (cols) => Math.ceil(n / cols) * KEY_H + (Math.ceil(n / cols) - 1) * GAP <= r.h;
  let cols = 1;
  while (cols < n && !fits(cols)) cols++;
  const rows = Math.ceil(n / cols);
  const w = Math.max(KEY_MIN_W, Math.min(r.cap, Math.floor((r.w - (cols - 1) * GAP) / cols)));
  const gridW = cols * w + (cols - 1) * GAP, gridH = rows * KEY_H + (rows - 1) * GAP;
  const x0 = mid(r.x, r.w, gridW);
  const y0 = r.align === 'start' ? r.y : r.align === 'end' ? r.y + r.h - gridH : mid(r.y, r.h, gridH);
  // Keys share a width, so they share the largest scale the longest label fits.
  const scale = [3, 2, 1].find((s) => labels.every((t) => textWidth(t) * s + 8 <= w)) || 1;
  return labels.map((text, i) => (
    { x: x0 + (i % cols) * (w + GAP), y: y0 + Math.floor(i / cols) * (KEY_H + GAP), w, h: KEY_H, scale }
  ));
}

// ---- DOM binding ----

/** Insets of the safe area in CSS px, read from the #safe probe. */
function readInsets() {
  const probe = document.getElementById('safe');
  if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 };
  const cs = getComputedStyle(probe);
  const px = (v) => parseFloat(v) || 0;
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

/** The page's viewport in the units `layout` takes. */
export function viewport() {
  return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1, insets: readInsets() };
}

const rgba = (i, a) => `rgba(${RGB[i].join(',')},${a})`;
const INK = 0xc, EDGE = 0xa, PLATE = 2, LIT = 4, GOLD = 0x16;

function charCode(ch) {
  if (/[A-Za-z]/.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `Digit${ch}`;
  return ch === '-' ? 'Minus' : ch === ':' ? 'Semicolon' : '';
}

function drawLabel(cv, text) {
  const str = text.toUpperCase();
  cv.width = textWidth(str);
  cv.height = FONT_H;
  const c = cv.getContext('2d');
  c.fillStyle = PALETTE[INK];
  let x = 0;
  for (const ch of str) {
    const rows = FONT[ch];
    if (rows) rows.forEach((row, y) => { for (let i = 0; i < FONT_W; i++) if (row[i] === '#') c.fillRect(x + i, y, 1, 1); });
    x += FONT_W + 1;
  }
}

/**
 * Safari ignores user-scalable=no and zooms on a tap that starts within
 * DOUBLE_TAP_MS of the last lift. Cancelling that tap's touchend stops the
 * zoom and drops its click, so a soft key it starts and lifts on clicks
 * itself.
 */
function stopDoubleTapZoom() {
  let lastEnd = -Infinity;
  const quick = new Set();
  document.addEventListener('touchstart', (e) => {
    const gap = e.timeStamp - lastEnd;
    if (gap >= 0 && gap < DOUBLE_TAP_MS) for (const t of e.changedTouches) quick.add(t.identifier);
  }, { passive: true });
  document.addEventListener('touchcancel', (e) => { for (const t of e.changedTouches) quick.delete(t.identifier); });
  document.addEventListener('touchend', (e) => {
    lastEnd = e.timeStamp;
    const lifted = [...e.changedTouches].filter((t) => quick.delete(t.identifier));
    if (lifted.length === 0 || !e.cancelable) return;
    e.preventDefault();
    for (const t of lifted) {
      const key = t.target.closest && t.target.closest('#touch button');
      if (key && key.contains(document.elementFromPoint(t.clientX, t.clientY))) key.click();
    }
  }, { passive: false });
}

/**
 * The controls. `state()` reports what the game shows: { screen, typing,
 * resume, muted, difficulty }. `onMode()` runs when touch mode changes, so the caller can
 * refit the canvas through `relayout`.
 */
export function createTouch({ state, onMode }) {
  const root = document.getElementById('touch');
  const padEl = document.createElement('div');
  padEl.id = 'pad';
  const padCv = document.createElement('canvas');
  padEl.append(padCv);
  root.append(padEl);
  const pad = createPad();
  const buttons = new Map();
  let on = touchAtBoot({
    maxTouchPoints: navigator.maxTouchPoints,
    coarse: Boolean(globalThis.matchMedia && matchMedia('(any-pointer: coarse)').matches),
    hash: location.hash,
  });
  let lay = null, sig = null, padSig = null;

  function send(type, code, key) {
    window.dispatchEvent(new KeyboardEvent(type, { code, key, repeat: false, bubbles: true, cancelable: true }));
  }
  function run(ops) {
    for (const o of ops) send(o.type, o.code, o.key);
    refresh();
  }
  function tap(code, key) {
    send('keydown', code, key);
    refresh();
    send('keyup', code, key);
    refresh();
  }
  // The native field takes a pasted save code and leaves the page's size alone.
  function typeCode() {
    tap('KeyT', 't');
    const answer = window.prompt('Seed or save code');
    if (answer === null || answer === undefined) { tap('Escape', 'Escape'); return; }
    for (const ch of String(answer)) { send('keydown', charCode(ch), ch); refresh(); }
    tap('Enter', 'Enter');
  }

  for (const [sid, list] of Object.entries(SOFT)) {
    for (const k of list) {
      const el = document.createElement('button');
      el.type = 'button';
      el.tabIndex = -1;
      const cv = document.createElement('canvas');
      el.append(cv);
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('down'); });
      for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, () => el.classList.remove('down'));
      el.addEventListener('click', () => {
        el.blur();
        if (k.act === 'type') typeCode(); else tap(k.code, k.key);
      });
      root.append(el);
      buttons.set(`${sid}/${k.id}`, { el, cv, text: '' });
    }
  }

  function viewOf(e) {
    const r = padEl.getBoundingClientRect();
    return { dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2), D: r.width };
  }
  padEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { padEl.setPointerCapture(e.pointerId); } catch { /* a dispatched pointer cannot be captured */ }
    const { dx, dy, D } = viewOf(e);
    run(pad.down(e.pointerId, dx, dy, D));
  });
  window.addEventListener('pointermove', (e) => {
    if (!pad.has(e.pointerId)) return;
    const { dx, dy, D } = viewOf(e);
    run(pad.move(e.pointerId, dx, dy, D));
  });
  for (const t of ['pointerup', 'pointercancel']) {
    window.addEventListener(t, (e) => { if (pad.has(e.pointerId)) run(pad.up(e.pointerId)); });
  }
  const releaseAll = () => run(pad.releaseAll());
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  stopDoubleTapZoom();

  function setOn(next) {
    if (next === on) return;
    on = next;
    if (!on) releaseAll();
    onMode(on);
  }
  window.addEventListener('pointerdown', (e) => setOn(nextTouchMode(on, e)), true);
  window.addEventListener('keydown', (e) => setOn(nextTouchMode(on, e)), true);

  function drawPad(held, centre) {
    const s = lay.pad.s, dpr = lay.backing.w / lay.view.w;
    padCv.width = Math.round(s * dpr);
    padCv.height = padCv.width;
    padCv.style.width = padCv.style.height = `${s}px`;
    const c = padCv.getContext('2d');
    c.scale(dpr, dpr);
    const alpha = lay.mode === 'overlay' ? 0.6 : 1;
    const r = s / 2;
    c.fillStyle = rgba(PLATE, alpha);
    c.strokeStyle = PALETTE[EDGE];
    c.lineWidth = 2;
    c.beginPath(); c.arc(r, r, r - 1, 0, Math.PI * 2); c.fill(); c.stroke();
    const arm = (dir, ax, ay) => {
      const a = s * 0.12, d = s * 0.34;
      c.fillStyle = held.has(dir) ? PALETTE[GOLD] : PALETTE[INK];
      c.beginPath();
      c.moveTo(r + ax * (d + a), r + ay * (d + a));
      c.lineTo(r + ax * (d - a) - ay * a * 1.2, r + ay * (d - a) + ax * a * 1.2);
      c.lineTo(r + ax * (d - a) + ay * a * 1.2, r + ay * (d - a) - ax * a * 1.2);
      c.closePath(); c.fill();
    };
    arm('l', -1, 0); arm('r', 1, 0); arm('u', 0, -1); arm('d', 0, 1);
    c.fillStyle = centre ? PALETTE[GOLD] : rgba(LIT, 1);
    c.strokeStyle = PALETTE[EDGE];
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(r, r, s / 6, 0, Math.PI * 2); c.fill(); c.stroke();
    c.strokeStyle = centre ? PALETTE[0] : PALETTE[INK];
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(r - s * 0.06, r + s * 0.03); c.lineTo(r, r - s * 0.04); c.lineTo(r + s * 0.06, r + s * 0.03); c.stroke();
  }

  function place() {
    const st = state();
    const sid = screenId(st);
    const shown = softKeys(st);
    root.style.display = on ? 'block' : 'none';
    root.style.setProperty('--bg', rgba(PLATE, lay.mode === 'overlay' ? 0.72 : 1));
    root.style.setProperty('--bg-down', rgba(LIT, 1));
    root.style.setProperty('--edge', PALETTE[EDGE]);
    root.style.setProperty('--gold', PALETTE[GOLD]);
    for (const b of buttons.values()) b.el.style.display = 'none';
    if (!on) return;
    const rects = keyRects(lay, sid, shown.map((k) => k.text));
    shown.forEach((k, i) => {
      const b = buttons.get(`${sid}/${k.id}`), q = rects[i];
      if (b.text !== k.text) { drawLabel(b.cv, k.text); b.text = k.text; }
      b.cv.style.width = `${textWidth(k.text) * q.scale}px`;
      b.cv.style.height = `${FONT_H * q.scale}px`;
      Object.assign(b.el.style, { display: 'flex', left: `${q.x}px`, top: `${q.y}px`, width: `${q.w}px`, height: `${q.h}px` });
    });
    if (sid === 'play' && lay.pad) {
      Object.assign(padEl.style, { display: 'block', left: `${lay.pad.x}px`, top: `${lay.pad.y}px`, width: `${lay.pad.s}px`, height: `${lay.pad.s}px` });
      padSig = null;
    } else {
      padEl.style.display = 'none';
      releaseIdle();
    }
  }
  // Leaving play lifts every held direction, so no key outlives its control.
  function releaseIdle() {
    const ops = pad.releaseAll();
    for (const o of ops) send(o.type, o.code, o.key);
  }

  function refresh() {
    // A layout from before a mode change waits for `relayout`.
    if (!lay || (lay.mode !== 'keyboard') !== on) return;
    const st = state();
    const next = `${on}|${screenId(st)}|${st.resume}|${st.muted}|${st.difficulty}`;
    if (next !== sig) { sig = next; place(); }
    if (on && padEl.style.display === 'block') {
      const held = pad.held(), centre = pad.centre();
      const ps = `${[...held].sort().join('')}|${centre}`;
      if (ps !== padSig) { padSig = ps; drawPad(held, centre); }
    }
  }

  return {
    get on() { return on; },
    /** Recomputes the layout from the page, places the controls and returns it. */
    relayout() {
      lay = layout({ ...viewport(), touch: on });
      sig = null;
      refresh();
      return lay;
    },
    refresh,
    padEl,
    soft: (sid, id) => buttons.get(`${sid}/${id}`).el,
  };
}
