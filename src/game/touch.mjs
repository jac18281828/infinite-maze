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
// The fire button's diameter: a fraction of the pad's, never under Apple's
// 44 px hit target.
export const FIRE_FRAC = 0.4;
export const FIRE_MIN = 44;
const GAP = 8;
// A key column's row gap may close to this before the keys wrap.
const MIN_GAP = 6;
const KEY_H = 44;
const KEY_MIN_W = 44;
const PAUSE_W = 96;
export const DOUBLE_TAP_MS = 350;
// The pad and the fire button draw translucent over the view in overlay mode.
const OVERLAY_ALPHA = 0.6;

// The fewest device pixels per game pixel at which touch mode scales the view
// by a whole number. This is the owner's trade of shimmer against view size:
// below it a fractional fill costs less than the view a whole scale gives up.
// Centring a whole view keeps the title's explorer below the left key column
// at every whole k of at least 3, so the threshold may fall to 3 and no lower.
const WHOLE_MIN = 6;

const mid = (a, size, inner) => a + (size - inner) / 2;

/**
 * The pad and the fire button for a pad of diameter D whose left edge and top
 * are x and y. The fire button mirrors the pad across the safe area's
 * vertical centre line at the pad's height; `swap` exchanges their sides.
 */
function controls(safe, D, swap, x, y) {
  const s = Math.max(FIRE_MIN, Math.floor(FIRE_FRAC * D));
  const c2 = 2 * safe.x + safe.w;
  const padCx = swap ? c2 - (x + D / 2) : x + D / 2;
  const fireCx = c2 - padCx;
  return {
    pad: { x: padCx - D / 2, y, s: D },
    fire: { x: fireCx - s / 2, y: y + D / 2 - s / 2, s },
  };
}

/**
 * Where the view, the d-pad, the fire button and the soft-key areas go.
 * Keyboard mode scales by the largest whole multiple of CSS pixels. Touch
 * mode fits the view to the safe area: 'band' puts the view at the top with
 * the controls below; 'overlay' centres the view and floats the controls over
 * it. When the fit holds at least WHOLE_MIN device pixels per game pixel, the
 * view takes the largest whole number k of them, centred across, and the page
 * background fills the letterbox; below that it fills the safe area at a
 * fractional scale. The fire button stands opposite the pad at the pad's
 * height; `swap` reflects both across the safe area's vertical centre line.
 * The backing store is in device pixels and the CSS size is backing / dpr.
 */
export function layout({ w, h, dpr = 1, insets = {}, touch, swap = false }) {
  if (!touch) {
    const k = Math.max(1, Math.floor(Math.min(w / VIEW_W, h / VIEW_H)));
    const vw = VIEW_W * k, vh = VIEW_H * k;
    return {
      mode: 'keyboard', scale: k, D: 0, pad: null, fire: null, band: null,
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
  const k = Math.floor(Math.min(bw / VIEW_W, bh / VIEW_H));
  const whole = k >= WHOLE_MIN;
  if (whole) {
    bw = VIEW_W * k;
    bh = VIEW_H * k;
  }
  const vw = bw / dpr, vh = bh / dpr;
  const snap = (v) => Math.round(v * dpr) / dpr;
  const vx = snap(mid(safe.x, safe.w, vw));
  if (band) {
    // A whole view's corner lies on a device pixel, so the band starts below it.
    const vy = whole ? snap(safe.y) : safe.y;
    const rest = { x: safe.x, y: vy + vh, w: safe.w, h: whole ? safe.y + safe.h - vy - vh : safe.h - vh };
    // The pad's centre rests a quarter in, where a left thumb sits on a
    // controller, and halfway down the band, within thumb reach.
    // Its top stays MARGIN below the view and its left MARGIN inside the edge.
    const top = Math.max(rest.y + MARGIN, rest.y + rest.h / 2 - D / 2);
    return {
      mode: 'band', D, safe, band: rest, scale: vw / VIEW_W,
      view: { x: vx, y: vy, w: vw, h: vh }, backing: { w: bw, h: bh },
      ...controls(safe, D, swap, rest.x + Math.max(MARGIN, rest.w / 4 - D / 2), top),
    };
  }
  return {
    mode: 'overlay', D, safe, band: null, scale: vw / VIEW_W,
    view: { x: vx, y: snap(mid(safe.y, safe.h, vh)), w: vw, h: vh }, backing: { w: bw, h: bh },
    ...controls(safe, D, swap, safe.x + MARGIN, safe.y + safe.h - MARGIN - D),
  };
}

/** The side the d-pad stands on for a stored value: 'right' only for 'right'. */
export function padSide(value) {
  return value === 'right' ? 'right' : 'left';
}

/**
 * The preview explorer's feet on the title, in view px. In overlay mode the
 * key columns hold the left strip, so he stands below them.
 */
export function titleFeet(lay) {
  return lay && lay.mode === 'overlay' ? [42, 176] : [42, 108];
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

/** The pad zone of an offset from its centre: 'c' (neutral, sends nothing) or an arm 'l', 'r', 'u', 'd'. */
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
 * pointer holds it; the centre holds none.
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
  };
}

const K = (code, key) => ({ code, key });
/**
 * Soft keys per screen, each a key that screen's handler accepts. `when`
 * gates a key on the game's state; `alt` is its label when muted; a key with
 * `setting` reads the difficulty setting as its label and one with `side` the
 * d-pad's side. Keys with `row` stand first, one for each slot digit of
 * `state.rows`, in its order.
 */
export const SOFT = {
  // BEGIN sends Space, which begins wherever the title's cursor stands; Enter acts on the lit row.
  title: [
    { id: 'resume', label: 'RESUME', ...K('KeyP', 'p'), when: 'resume' },
    { id: 'begin', label: 'BEGIN', ...K('Space', ' ') },
    { id: 'reset', label: 'RESET', ...K('KeyR', 'r') },
    { id: 'load', label: 'LOAD', ...K('KeyT', 't') },
    { id: 'difficulty', label: 'MEDIUM', setting: true, ...K('KeyL', 'l') },
    { id: 'copy', label: 'COPY', ...K('KeyK', 'k') },
    { id: 'sound', label: 'SOUND', alt: 'MUTED', ...K('KeyM', 'm') },
    { id: 'pad', label: 'PAD LEFT', side: true, ...K('KeyH', 'h') },
  ],
  load: [
    { id: 's1', label: 'SLOT 1', ...K('Digit1', '1') },
    { id: 's2', label: 'SLOT 2', ...K('Digit2', '2') },
    { id: 's3', label: 'SLOT 3', ...K('Digit3', '3') },
    { id: 'type', label: 'TYPE CODE', act: 'type' },
    { id: 'back', label: 'BACK', ...K('KeyQ', 'q') },
  ],
  pick: [
    { id: 's1', label: 'SLOT 1', ...K('Digit1', '1') },
    { id: 's2', label: 'SLOT 2', ...K('Digit2', '2') },
    { id: 's3', label: 'SLOT 3', ...K('Digit3', '3') },
    { id: 'back', label: 'BACK', ...K('KeyQ', 'q') },
  ],
  typing: [
    { id: 'accept', label: 'ACCEPT', ...K('Enter', 'Enter') },
    { id: 'cancel', label: 'CANCEL', ...K('Escape', 'Escape') },
  ],
  confirm: [
    { id: 'yes', label: 'YES', ...K('KeyY', 'y') },
    { id: 'no', label: 'NO', ...K('KeyN', 'n') },
  ],
  savein: [
    { id: 's1', label: 'SLOT 1', ...K('Digit1', '1'), row: 1 },
    { id: 's2', label: 'SLOT 2', ...K('Digit2', '2'), row: 2 },
    { id: 's3', label: 'SLOT 3', ...K('Digit3', '3'), row: 3 },
    { id: 'back', label: 'BACK', ...K('KeyQ', 'q') },
  ],
  play: [
    { id: 'pause', label: 'PAUSE', ...K('KeyP', 'p') },
  ],
  pause: [
    { id: 'resume', label: 'RESUME', ...K('KeyP', 'p') },
    { id: 'save', label: 'SAVE', ...K('Enter', 'Enter'), when: 'save' },
    { id: 'copy', label: 'COPY', ...K('KeyC', 'c') },
    { id: 'sound', label: 'SOUND', alt: 'MUTED', ...K('KeyM', 'm') },
    { id: 'title', label: 'TITLE', ...K('KeyQ', 'q') },
  ],
  over: [
    { id: 'continue', label: 'CONTINUE', ...K('Enter', 'Enter') },
    { id: 'copy', label: 'COPY', ...K('KeyC', 'c') },
    { id: 'title', label: 'TITLE', ...K('KeyQ', 'q') },
  ],
  splash: [
    { id: 'continue', label: 'CONTINUE', ...K('Enter', 'Enter') },
    { id: 'home', label: 'HOME', ...K('KeyQ', 'q') },
  ],
};

/**
 * The table row for the game's state: 'confirm' is a confirm open on the
 * title, LOAD, the pick or SAVE IN?, and 'typing' LOAD with its code field
 * open.
 */
export function screenId({ screen, typing, confirm }) {
  if (confirm && (screen === 'title' || screen === 'load' || screen === 'pick' || screen === 'savein')) return 'confirm';
  if (screen === 'load' && typing) return 'typing';
  return screen;
}

/** The on-screen name of a difficulty: 'easy' reads EASY. */
export function difficultyLabel(difficulty) {
  return difficulty.toUpperCase();
}

/** The soft keys shown for a game state, with labels resolved. */
export function softKeys(state) {
  const text = (k) => (
    k.setting && state.difficulty ? difficultyLabel(state.difficulty)
      : k.side && state.side ? `PAD ${state.side.toUpperCase()}`
        : state.muted && k.alt ? k.alt : k.label
  );
  const list = SOFT[screenId(state)] || [];
  const rows = [...(state.rows || '')].map((d) => list.find((k) => k.row === Number(d))).filter(Boolean);
  return [...rows, ...list.filter((k) => !k.row && (!k.when || state[k.when]))].map((k) => ({ ...k, text: text(k) }));
}

export function textWidth(str) {
  return str.length * (FONT_W + 1) - 1;
}

// Horizontal extent of each screen's panel in view pixels (the r.panel calls
// in main.mjs). Overlay-mode keys stay in the strips outside it, so they
// never cover the panel, the title's note line or its footer.
export const PANEL_X = {
  title: [62, 258], load: [62, 258], pick: [62, 258], typing: [62, 258], confirm: [62, 258], savein: [62, 258],
  pause: [50, 270], over: [40, 280], splash: [50, 270],
};

// The screens whose keys stand over the title's preview explorer in the left
// strip. A confirm draws over it on the title, LOAD and the pick.
const TITLE_SIDS = new Set(['title', 'load', 'pick', 'typing', 'confirm']);

// The PAUSE key stands at the bottom centre, between the controls like a
// console's START. Where that comes within GAP of the pad or the fire button
// (a narrow safe area) it moves over the fire button, just above it.
function pauseSpot(lay) {
  const { safe, pad, fire } = lay;
  const home = { x: safe.x + safe.w / 2 - PAUSE_W / 2, y: safe.y + safe.h - GAP - KEY_H };
  const near = (o) => home.x < o.x + o.s + GAP && home.x + PAUSE_W > o.x - GAP
    && home.y < o.y + o.s + GAP && home.y + KEY_H > o.y - GAP;
  if (!near(pad) && !near(fire)) return home;
  const x = Math.min(Math.max(fire.x + fire.s / 2 - PAUSE_W / 2, safe.x + GAP), safe.x + safe.w - GAP - PAUSE_W);
  const above = fire.y - GAP - KEY_H;
  return { x, y: lay.mode === 'band' ? Math.min(lay.band.y + GAP, above) : above };
}

// Overlay keys stand in the strips beside the panel, outside it.
function overlayStrips(lay, sid) {
  const { safe } = lay;
  const [px0, px1] = PANEL_X[sid];
  const edge = (x, w) => ({ x, y: safe.y + GAP, w, h: safe.h - 2 * GAP, cap: 140, align: 'center' });
  const l = safe.x + GAP, r = lay.view.x + px1 * lay.scale + GAP;
  return [edge(l, lay.view.x + px0 * lay.scale - GAP - l), edge(r, safe.x + safe.w - GAP - r)];
}

function keyRegion(lay, sid) {
  if (sid === 'play') {
    const at = pauseSpot(lay);
    return { x: at.x, y: at.y, w: PAUSE_W, h: KEY_H, cap: PAUSE_W, align: 'start' };
  }
  if (lay.mode === 'band') {
    return { x: lay.band.x + MARGIN, y: lay.band.y + GAP, w: lay.band.w - 2 * MARGIN, h: lay.band.h - 2 * GAP, cap: 240, align: 'center' };
  }
  const [left, right] = overlayStrips(lay, sid);
  // The title's preview explorer stands in the left strip, so a single column
  // always takes the right one.
  if (TITLE_SIDS.has(sid)) return right;
  return right.w >= left.w ? right : left;
}

// `count` keys in region `r`: columns by MIN_GAP, then the key width, row gap
// and top left of the grid. Rows sit GAP apart, closing to MIN_GAP before the
// keys wrap to another column.
function grid(r, count) {
  const rowGap = (cols) => {
    const rows = Math.ceil(count / cols);
    return rows < 2 ? GAP : Math.min(GAP, Math.floor((r.h - rows * KEY_H) / (rows - 1)));
  };
  let cols = 1;
  while (cols < count && rowGap(cols) < MIN_GAP) cols++;
  const rows = Math.ceil(count / cols), gap = rowGap(cols);
  const w = Math.max(KEY_MIN_W, Math.min(r.cap, Math.floor((r.w - (cols - 1) * GAP) / cols)));
  const gridW = cols * w + (cols - 1) * GAP, gridH = rows * KEY_H + (rows - 1) * gap;
  const y0 = r.align === 'start' ? r.y : r.align === 'end' ? r.y + r.h - gridH : mid(r.y, r.h, gridH);
  return { cols, gap, w, x0: mid(r.x, r.w, gridW), y0 };
}

/**
 * Rectangles for the soft keys of screen `sid`, one per label, in order.
 * Each carries one label scale (3, 2 or 1), the largest that fits every label.
 * Rows sit GAP apart, closing to MIN_GAP before the keys wrap to another
 * column; a layout that fits at GAP keeps it. In overlay mode a screen whose
 * keys do not fit one column in one strip stands one column in each strip,
 * the first half of the keys left and the rest right. Over the title's
 * explorer a single column stands in the right strip, and a left column at the
 * top of its strip.
 */
export function keyRects(lay, sid, labels) {
  const n = labels.length;
  if (n === 0 || lay.mode === 'keyboard') return [];
  const one = grid(keyRegion(lay, sid), n);
  let spots;
  if (lay.mode === 'overlay' && sid !== 'play' && one.cols > 1) {
    const half = Math.ceil(n / 2), [strip, right] = overlayStrips(lay, sid);
    // Over the title explorer the left column stands at the top of its strip, above it.
    const left = TITLE_SIDS.has(sid) ? { ...strip, align: 'start' } : strip;
    const gl = grid(left, half), gr = grid(right, n - half);
    const w = Math.min(gl.w, gr.w);
    const col = (g, r, count) => Array.from({ length: count }, (_, i) => (
      { x: mid(r.x, r.w, w), y: g.y0 + i * (KEY_H + g.gap), w }));
    spots = [...col(gl, left, half), ...col(gr, right, n - half)];
  } else {
    spots = labels.map((_, i) => (
      { x: one.x0 + (i % one.cols) * (one.w + GAP), y: one.y0 + Math.floor(i / one.cols) * (KEY_H + one.gap), w: one.w }));
  }
  // Keys share a width, so they share the largest scale the narrowest label fits.
  const w = Math.min(...spots.map((q) => q.w));
  const scale = [3, 2, 1].find((sc) => labels.every((t) => textWidth(t) * sc + 8 <= w)) || 1;
  return spots.map((q) => ({ x: q.x, y: q.y, w: q.w, h: KEY_H, scale }));
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
const INK = 0xc, EDGE = 0xa, PLATE = 2, LIT = 4, GOLD = 0x16, TORCH_RED = 0x17, TORCH_ORANGE = 0x18;

function charCode(ch) {
  if (/[A-Za-z]/.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `Digit${ch}`;
  return ch === '-' ? 'Minus' : ch === ':' ? 'Semicolon' : '';
}

export function drawLabel(cv, text) {
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
 * Which touches began within DOUBLE_TAP_MS of the last lift: the quick ones,
 * whose lift the zoom guard cancels. A touch outside the window drops its
 * identifier, because Android reuses identifiers and one that never ended
 * would make a later slow tap read as quick. Times are `timeStamp` ms.
 */
export function createQuickTaps() {
  let lastEnd = -Infinity;
  const quick = new Set();
  return {
    start(id, at) {
      const gap = at - lastEnd;
      if (gap >= 0 && gap < DOUBLE_TAP_MS) quick.add(id); else quick.delete(id);
    },
    cancel(id) { quick.delete(id); },
    /** Records the lift at `at`; true when the touch began quick. */
    lift(id, at) {
      lastEnd = at;
      return quick.delete(id);
    },
  };
}

/**
 * The settle window of the soft keys. Keys stand by list position, so after a
 * screen change another key may stand where the tapped one did, and the quick
 * second tap of a double tap would answer the screen it opened. A press that
 * begins within DOUBLE_TAP_MS of the soft keys' screen changing drops. The
 * first screen seen starts no window; neither does a change within one screen.
 * Times are `timeStamp` ms.
 *
 * `drops` requires `at - since >= 0`: a press stamped before the change acts.
 * When an engine's event clock and `performance.now()` disagree, the rule
 * fails open and never swallows every press.
 */
export function createSettle() {
  let current = null, since = -Infinity;
  return {
    /** Records that screen `sid` shows at `at`; a different screen from the last starts the window. */
    screen(sid, at) {
      if (current !== null && sid !== current) since = at;
      current = sid;
    },
    /** True when a press beginning at `at` falls in the window. */
    drops(at) { return at - since >= 0 && at - since < DOUBLE_TAP_MS; },
    /** When the window opened; -Infinity before any screen change. */
    get since() { return since; },
  };
}

/**
 * One soft key's press against the settle window. A press is judged where it
 * begins, so a long hold that lifts still drops. A click with no press before
 * it (keyboard activation, a script) is not a press and acts.
 */
export function createSoftPress(settle) {
  let dropped = false;
  return {
    /** Judges a press beginning at `at`; true when it drops. */
    down(at) { return (dropped = settle.drops(at)); },
    /** Clears the judgement of a cancelled press. */
    cancel() { dropped = false; },
    /** Ends the press at its click; true when the click is to do nothing. */
    click() {
      const drop = dropped;
      dropped = false;
      return drop;
    },
  };
}

/**
 * Safari ignores user-scalable=no and zooms on a tap that starts within
 * DOUBLE_TAP_MS of the last lift. Cancelling that tap's touchend stops the
 * zoom and drops its click, so a soft key it starts and lifts on clicks
 * itself.
 */
function stopDoubleTapZoom() {
  const taps = createQuickTaps();
  document.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) taps.start(t.identifier, e.timeStamp);
  }, { passive: true });
  document.addEventListener('touchcancel', (e) => { for (const t of e.changedTouches) taps.cancel(t.identifier); });
  document.addEventListener('touchend', (e) => {
    const lifted = [...e.changedTouches].filter((t) => taps.lift(t.identifier, e.timeStamp));
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
 * confirm, resume, save, rows, muted, difficulty, side }, `side` being the
 * d-pad's and `rows` the slot digits a screen's row keys follow. `onMode()` runs when touch mode changes, so the caller can refit the
 * canvas through `relayout`.
 */
export function createTouch({ state, onMode }) {
  const root = document.getElementById('touch');
  // A round control: a div holding one canvas.
  const disc = (id) => {
    const el = document.createElement('div');
    el.id = id;
    const cv = document.createElement('canvas');
    el.append(cv);
    root.append(el);
    return { el, cv };
  };
  const { el: padEl, cv: padCv } = disc('pad');
  const { el: fireEl, cv: fireCv } = disc('fire');
  const pad = createPad();
  // Pointers holding the fire button. They never enter the pad's bookkeeping.
  const fireHeld = new Set();
  const buttons = new Map();
  const settle = createSettle();
  let on = touchAtBoot({
    maxTouchPoints: navigator.maxTouchPoints,
    coarse: Boolean(globalThis.matchMedia && matchMedia('(any-pointer: coarse)').matches),
    hash: location.hash,
  });
  let lay = null, laySide = null, sig = null, padSig = null, fireSig = null;

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
      const press = createSoftPress(settle);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!press.down(e.timeStamp)) el.classList.add('down');
      });
      for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, () => el.classList.remove('down'));
      el.addEventListener('pointercancel', () => press.cancel());
      el.addEventListener('click', () => {
        el.blur();
        if (press.click()) return;
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
  // Takes a pointer for `el`: no default action, and its moves and lift follow it.
  function capture(el, e) {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* a dispatched pointer cannot be captured */ }
  }
  padEl.addEventListener('pointerdown', (e) => {
    capture(padEl, e);
    const { dx, dy, D } = viewOf(e);
    run(pad.down(e.pointerId, dx, dy, D));
  });
  window.addEventListener('pointermove', (e) => {
    if (!pad.has(e.pointerId)) return;
    const { dx, dy, D } = viewOf(e);
    run(pad.move(e.pointerId, dx, dy, D));
  });
  for (const t of ['pointerup', 'pointercancel']) {
    window.addEventListener(t, (e) => {
      if (pad.has(e.pointerId)) run(pad.up(e.pointerId));
      if (fireHeld.delete(e.pointerId)) refresh();
    });
  }
  // A jump fires on press, so the fire button takes `pointerdown`, not a click.
  fireEl.addEventListener('pointerdown', (e) => {
    capture(fireEl, e);
    fireHeld.add(e.pointerId);
    tap(SPACE.code, SPACE.key);
  });
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

  // Sizes `cv` to s CSS px at the backing's resolution and returns its context in CSS px.
  function sizeDisc(cv, s) {
    const dpr = lay.backing.w / lay.view.w;
    cv.width = Math.round(s * dpr);
    cv.height = cv.width;
    cv.style.width = cv.style.height = `${s}px`;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);
    return c;
  }
  const discAlpha = () => (lay.mode === 'overlay' ? OVERLAY_ALPHA : 1);

  function drawPad(held) {
    const s = lay.pad.s, c = sizeDisc(padCv, s);
    const alpha = discAlpha();
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
    // A plain hub: the centre is a dead zone and never lights.
    c.fillStyle = rgba(LIT, 1);
    c.strokeStyle = PALETTE[EDGE];
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(r, r, s / 6, 0, Math.PI * 2); c.fill(); c.stroke();
  }

  // A red arcade button; a held pointer lights it torch orange with a gold rim.
  function drawFire(down) {
    const s = lay.fire.s, c = sizeDisc(fireCv, s);
    const r = s / 2;
    c.fillStyle = rgba(down ? TORCH_ORANGE : TORCH_RED, discAlpha());
    c.strokeStyle = PALETTE[down ? GOLD : EDGE];
    c.lineWidth = 2;
    c.beginPath(); c.arc(r, r, r - 1, 0, Math.PI * 2); c.fill(); c.stroke();
  }

  function place() {
    const st = state();
    const sid = screenId(st);
    const shown = softKeys(st);
    settle.screen(sid, performance.now());
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
      const box = (o) => ({ display: 'block', left: `${o.x}px`, top: `${o.y}px`, width: `${o.s}px`, height: `${o.s}px` });
      Object.assign(padEl.style, box(lay.pad));
      Object.assign(fireEl.style, box(lay.fire));
      padSig = null;
      fireSig = null;
    } else {
      padEl.style.display = 'none';
      fireEl.style.display = 'none';
      fireHeld.clear();
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
    if (st.side !== laySide) compute();
    // Every field softKeys reads, since a confirm's re-read changes the keys with no screen write.
    const next = `${on}|${screenId(st)}|${st.resume}|${st.save}|${st.rows}|${st.muted}|${st.difficulty}|${st.side}`;
    if (next !== sig) { sig = next; place(); }
    if (on && padEl.style.display === 'block') {
      const held = pad.held();
      const ps = [...held].sort().join('');
      if (ps !== padSig) { padSig = ps; drawPad(held); }
      const fs = String(fireHeld.size > 0);
      if (fs !== fireSig) { fireSig = fs; drawFire(fireHeld.size > 0); }
    }
  }

  // The layout for the page as it stands and the side the game reports.
  function compute() {
    laySide = state().side;
    lay = layout({ ...viewport(), touch: on, swap: laySide === 'right' });
    sig = null;
  }

  return {
    get on() { return on; },
    /** Recomputes the layout from the page, places the controls and returns it. */
    relayout() {
      compute();
      refresh();
      return lay;
    },
    refresh,
    /** When the soft keys' screen last changed, in `timeStamp` ms; -Infinity before a change. */
    get settledSince() { return settle.since; },
    /** The layout in force; null before the first `relayout`. */
    get lay() { return lay; },
    padEl,
    fireEl,
    soft: (sid, id) => buttons.get(`${sid}/${id}`).el,
  };
}
