import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  layout, nextTouchMode, touchAtBoot, padZone, createPad, SOFT, softKeys, keyRects, MARGIN, PANEL_X, textWidth,
  FIRE_FRAC, FIRE_MIN, padSide, titleFeet, createQuickTaps,
} from '../src/game/touch.mjs';
import { createFrame, placeFrame, deviceSpan } from '../src/game/camera.mjs';
import { build } from '../tools/build.mjs';
import { DIFFICULTIES } from '../src/world/band.mjs';

const PORTRAIT = { w: 393, h: 852, dpr: 3, insets: { top: 59, bottom: 34, left: 0, right: 0 }, touch: true };
const LANDSCAPE = { w: 852, h: 393, dpr: 3, insets: { top: 0, bottom: 21, left: 59, right: 59 }, touch: true };
// A 360 px tall landscape phone: seven 44 px keys fit one column only at 6 px gaps.
const SHORT = { w: 640, h: 360, dpr: 2, insets: {}, touch: true };
const IPAD = { w: 820, h: 1180, dpr: 2, insets: {}, touch: true };
const PHONE = { w: 320, h: 568, dpr: 2, insets: {}, touch: true };
const LAND_375 = { ...LANDSCAPE, w: 667, h: 375, insets: {} };
const DESKTOP = { w: 1024, h: 768, dpr: 2, insets: {}, touch: true };
const BIG = { w: 1366, h: 1024, dpr: 2, insets: {}, touch: true };
const WIDE_320 = { w: 568, h: 320, dpr: 2, insets: {}, touch: true };
// A landscape phone at 4 device px a game px, height-limited: below 6x its view fills the safe height.
const LAND_700 = { w: 700, h: 360, dpr: 2, insets: {}, touch: true };
// A 1376 px wide band layout with a whole view and a 260 px band, where the halfway rest clears the clamp.
const IPAD_SHORT = { w: 1376, h: 980, dpr: 2, insets: {}, touch: true };
// A band layout whose rounded view leaves the band 1/6 px short of the halfway rest, so the MARGIN clamp binds.
const SHORT_BAND = { w: 400, h: 417, dpr: 1.5, insets: {}, touch: true };
const FIXTURES = [PORTRAIT, LANDSCAPE, SHORT, LAND_375, DESKTOP, IPAD, PHONE, BIG, WIDE_320];
const GAP = 8;

test('keyboard mode scales by the largest whole multiple of CSS pixels', () => {
  for (const [w, h, k] of [[1280, 720, 4], [1000, 700, 3], [300, 200, 1]]) {
    const lay = layout({ w, h, dpr: 2, touch: false });
    assert.equal(lay.mode, 'keyboard');
    assert.equal(lay.scale, k);
    assert.deepEqual(lay.backing, { w: 320 * k, h: 180 * k });
    assert.equal(lay.view.w, 320 * k);
    assert.equal(lay.view.h, 180 * k);
  }
});

test('a portrait phone lands in band mode, the pad below the view in the safe area', () => {
  const lay = layout(PORTRAIT);
  const { view, pad, safe } = lay;
  assert.equal(lay.mode, 'band');
  assert.ok(Math.abs(view.w - safe.w) < 1 / 3);
  assert.equal(view.y, safe.y);
  assert.ok(pad.y >= view.y + view.h);
  assert.ok(pad.x >= safe.x && pad.x + pad.s <= safe.x + safe.w);
  assert.ok(pad.y + pad.s <= safe.y + safe.h);
  assert.equal(pad.s, 160);
});

test('a landscape phone lands in overlay mode, the pad M from the safe corner', () => {
  // 852 x 393 holds 6.2 device px a game px, so its view is whole and sits inside the safe height.
  for (const [spec, fills] of [[LANDSCAPE, false], [LAND_700, true]]) {
    const lay = layout(spec);
    const { view, pad, safe } = lay;
    assert.equal(lay.mode, 'overlay');
    assert.equal(Math.abs(view.h - safe.h) < 1 / 3, fills, `${spec.w}x${spec.h}: the view fills the safe height`);
    assert.ok(view.h <= safe.h + 1e-9);
    assert.equal(pad.x, safe.x + MARGIN);
    assert.equal(pad.y + pad.s, safe.y + safe.h - MARGIN);
    assert.equal(pad.s, Math.floor(0.42 * safe.h));
  }
});

test('below 6x touch mode fills the limiting dimension and the backing is the CSS size times the ratio', () => {
  for (const [spec, dim] of [[PORTRAIT, 'w'], [LAND_700, 'h']]) {
    const lay = layout(spec);
    const dpr = spec.dpr;
    assert.ok(Math.abs(lay.backing[dim] - lay.safe[dim] * dpr) <= 1, `${dim} fills within a device pixel`);
    assert.equal(lay.backing.w, Math.round(lay.view.w * dpr));
    assert.equal(lay.backing.h, Math.round(lay.view.h * dpr));
    assert.ok(lay.view.x >= lay.safe.x - 1e-9 && lay.view.x + lay.view.w <= lay.safe.x + lay.safe.w + 1e-9);
    assert.ok(lay.view.y >= lay.safe.y - 1e-9 && lay.view.y + lay.view.h <= lay.safe.y + lay.safe.h + 1e-9);
  }
});

// Touch viewports in CSS px: the iPad, the 6.1- and 6.9-inch iPhones, a desktop window in touch mode, an Android
// phone and a tiny window, each with the fit's mode and its whole scale k (0 below 6x and so a fallback).
const PHONE_INSETS = { top: 59, bottom: 34 };
const LAND_INSETS = { left: 59, right: 59, bottom: 21 };
const CASES = [
  { tag: 'iPad landscape', w: 1376, h: 1032, dpr: 2, mode: 'band', k: 8, frac: 8.6 },
  { tag: 'iPad portrait', w: 1032, h: 1376, dpr: 2, mode: 'band', k: 6, frac: 6.45 },
  { tag: '6.1-inch iPhone landscape', w: 852, h: 393, dpr: 3, mode: 'overlay', k: 6, frac: 6.55 },
  { tag: '6.9-inch iPhone landscape', w: 956, h: 440, dpr: 3, mode: 'overlay', k: 7, frac: 7.33 },
  { tag: 'desktop 1920x1080', w: 1920, h: 1080, dpr: 1, mode: 'overlay', k: 6, frac: 6 },
  { tag: 'Android landscape', w: 915, h: 412, dpr: 2.6, mode: 'overlay', k: 0, frac: 5.95 },
  { tag: '6.1-inch iPhone portrait', w: 393, h: 852, dpr: 3, mode: 'band', k: 0, frac: 3.68 },
  { tag: '6.9-inch iPhone portrait', w: 440, h: 956, dpr: 3, mode: 'band', k: 0, frac: 4.13 },
  { tag: '300x150', w: 300, h: 150, dpr: 1, mode: 'overlay', k: 0, frac: 0.83 },
];
// Each case again with insets of its own: the inset moves the fit and may move it across 6.
const INSETS = [
  { tag: 'iPad landscape, status and home bars', w: 1376, h: 1032, dpr: 2, insets: { top: 24, bottom: 20 } },
  { tag: 'iPad portrait, status and home bars', w: 1032, h: 1376, dpr: 2, insets: { top: 24, bottom: 20 } },
  { tag: '6.1-inch iPhone landscape, notch', w: 852, h: 393, dpr: 3, insets: LAND_INSETS },
  { tag: '6.9-inch iPhone landscape, notch', w: 956, h: 440, dpr: 3, insets: LAND_INSETS },
  { tag: 'desktop 1920x1080 under a 24 px bar', w: 1920, h: 1080, dpr: 1, insets: { top: 24 } },
  { tag: 'Android landscape, cut-out', w: 915, h: 412, dpr: 2.6, insets: { left: 44, right: 44, bottom: 21 } },
  { tag: '6.1-inch iPhone portrait, notch', w: 393, h: 852, dpr: 3, insets: PHONE_INSETS },
  { tag: '6.9-inch iPhone portrait, notch', w: 440, h: 956, dpr: 3, insets: PHONE_INSETS },
];
const specOf = (c, swap = false) => ({ w: c.w, h: c.h, dpr: c.dpr, insets: c.insets || {}, touch: true, swap });
/** The zero-inset fit's device px a game px and its whole scale, from the safe area alone: a band fits the width. */
function fitOf(c, mode) {
  const i = c.insets || {};
  const w = (c.w - (i.left || 0) - (i.right || 0)) * c.dpr, h = (c.h - (i.top || 0) - (i.bottom || 0)) * c.dpr;
  const frac = mode === 'band' ? w / 320 : Math.min(w / 320, h / 180);
  return { frac, k: Math.floor(frac) };
}
/** Every case with the mode the layout chose and the whole scale its own safe area gives. */
function laidOut() {
  return [...CASES, ...INSETS].map((c) => {
    const lay = layout(specOf(c));
    return { c, lay, ...fitOf(c, lay.mode) };
  });
}
const isDevicePx = (v, dpr) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6;

test('the table\'s viewports take the mode, fractional scale and whole scale the owner chose', () => {
  for (const c of CASES) {
    const lay = layout(specOf(c)), fit = fitOf(c, lay.mode);
    assert.equal(lay.mode, c.mode, c.tag);
    assert.ok(Math.abs(fit.frac - c.frac) < 0.005, `${c.tag}: ${fit.frac}`);
    assert.equal(fit.k >= 6 ? fit.k : 0, c.k, c.tag);
  }
});

test('a fit of at least 6 device px a game px backs the view 320k x 180k, scale k over the ratio', () => {
  let whole = 0;
  for (const { c, lay, k } of laidOut()) {
    if (k < 6) continue;
    whole++;
    assert.deepEqual(lay.backing, { w: 320 * k, h: 180 * k }, `${c.tag}: backing`);
    assert.ok(Math.abs(lay.scale - k / c.dpr) < 1e-9, `${c.tag}: scale ${lay.scale}`);
    assert.ok(Math.abs(lay.view.w * c.dpr - 320 * k) < 1e-6 && Math.abs(lay.view.h * c.dpr - 180 * k) < 1e-6, `${c.tag}: CSS size`);
  }
  assert.ok(whole >= 9, `${whole} whole layouts`);
  assert.deepEqual(layout(specOf(CASES[0])).backing, { w: 2560, h: 1440 });
  assert.deepEqual(layout(specOf(CASES[1])).backing, { w: 1920, h: 1080 });
  assert.deepEqual(layout(specOf(CASES[2])).backing, { w: 1920, h: 1080 });
  assert.deepEqual(layout(specOf(CASES[3])).backing, { w: 2240, h: 1260 });
  assert.deepEqual(layout(specOf(CASES[4])).backing, { w: 1920, h: 1080 });
});

test('the threshold is 6: 5.95x and 6.45x tell the rules apart', () => {
  // Android 915 x 412 at 2.6 holds 5.95 device px a game px: today's layout in every field, as 0ffeb99 gave it.
  const android = {
    mode: 'overlay', D: 160, safe: { x: 0, y: 0, w: 915, h: 412 }, band: null, scale: 2.2884615384615383,
    view: { x: 91.53846153846153, y: 0, w: 732.3076923076923, h: 411.9230769230769 }, backing: { w: 1904, h: 1071 },
    pad: { x: 16, y: 236, s: 160 }, fire: { x: 787, y: 284, s: 64 },
  };
  assert.deepEqual(layout({ w: 915, h: 412, dpr: 2.6, insets: {}, touch: true }), android);
  assert.deepEqual(layout({ w: 915, h: 412, dpr: 2.6, insets: {}, touch: true, swap: true }), {
    ...android, pad: { x: 739, y: 236, s: 160 }, fire: { x: 64, y: 284, s: 64 },
  });
  // The overlay view's y is -0 there, as at 0ffeb99.
  assert.deepEqual(layout({ w: 915, h: 412, dpr: 2.6, insets: { left: 44, right: 44, bottom: 21 }, touch: true }), {
    mode: 'overlay', D: 160, safe: { x: 44, y: 0, w: 827, h: 391 }, band: null, scale: 2.173076923076923,
    view: { x: 110, y: -0, w: 695.3846153846154, h: 391.15384615384613 }, backing: { w: 1808, h: 1017 },
    pad: { x: 60, y: 215, s: 160 }, fire: { x: 743, y: 263, s: 64 },
  });
  assert.deepEqual(layout({ w: 300, h: 150, dpr: 1, insets: {}, touch: true }), {
    mode: 'overlay', D: 63, safe: { x: 0, y: 0, w: 300, h: 150 }, band: null, scale: 0.834375,
    view: { x: 17, y: 0, w: 267, h: 150 }, backing: { w: 267, h: 150 }, pad: { x: 16, y: 71, s: 63 }, fire: { x: 230.5, y: 80.5, s: 44 },
  });
  // The iPad held portrait holds 6.45: whole at 6, 1920 x 1080, where the fractional fit would have been 2064 x 1161.
  const lay = layout(specOf(CASES[1]));
  assert.deepEqual(lay.backing, { w: 1920, h: 1080 });
  assert.ok(Math.abs(lay.view.w - 960) < 1e-9 && Math.abs(lay.view.h - 540) < 1e-9);
});

test('crossing 6 in either direction takes the other rule on the next layout, with no memory', () => {
  // A band layout 6 device px a game px wide is 960 CSS px at 2x; the view's width steps down at each whole k above it.
  const at = (w) => layout({ w, h: 4000, dpr: 2, insets: {}, touch: true }).view.w;
  assert.ok(Math.abs(at(959) - 959) < 1 / 3, '959 px: the fractional fit fills the width');
  assert.equal(at(960), 960);
  assert.equal(at(1000), 960);
  assert.equal(at(1119), 960);
  assert.equal(at(1120), 1120);
  assert.ok(Math.abs(at(959) - at(960)) < 1.01, 'the view is continuous across the threshold');
  for (const w of [1120, 959, 1000, 959, 1120, 960]) assert.equal(at(w), at(w), 'the layout is a function of the viewport');
});

test('a whole view maps each game pixel to exactly k device px at a fractional camera', () => {
  let whole = 0, placed = 0;
  for (const { c, lay, k } of laidOut()) {
    if (k < 6) continue;
    whole++;
    for (const cam of [{ x: 1234.37, y: -567.61 }, { x: -0.5001, y: 90.999 }, { x: 77.25, y: 13.75 }]) {
      const fr = createFrame();
      placeFrame(fr, cam, lay.backing.w, lay.backing.h, 320, 180);
      assert.ok(fr.sx === k && fr.sy === k, `${c.tag}: sx ${fr.sx}, sy ${fr.sy}, not ${k}`);
      // A span of n game px covers n·k device px at every corner a layer or sprite can take.
      for (const [a, b] of [[fr.worldX, fr.worldY], [fr.wallX, fr.wallY], [fr.ox + cam.x * k + 0.3, fr.oy - cam.y * k + 0.7], [fr.ox + 17.3 * k, fr.oy - 4.9 * k]]) {
        for (const n of [1, 3, 16, 24, 324]) {
          assert.equal(deviceSpan(a, n * k), n * k, `${c.tag}: ${n} game px from device x ${a}`);
          assert.equal(deviceSpan(b, n * k), n * k, `${c.tag}: ${n} game px from device y ${b}`);
        }
      }
      placed++;
    }
  }
  assert.ok(whole >= 9 && placed === 3 * whole);
});

test('a whole overlay view centres on both axes, a whole band view across with its top at the safe top, every corner on a device pixel', () => {
  let overlay = 0, band = 0;
  for (const { c, lay, k } of laidOut()) {
    if (k < 6) continue;
    const { view, safe } = lay, tag = c.tag;
    assert.ok(isDevicePx(view.x, c.dpr) && isDevicePx(view.y, c.dpr), `${tag}: the corner lies on a device pixel`);
    assert.ok(isDevicePx(view.x + view.w, c.dpr) && isDevicePx(view.y + view.h, c.dpr), `${tag}: the far corner lies on a device pixel`);
    assert.ok(Math.abs(view.x - (safe.x + (safe.w - view.w) / 2)) <= 0.5 / c.dpr + 1e-9, `${tag}: centred across`);
    if (lay.mode === 'overlay') {
      overlay++;
      assert.ok(Math.abs(view.y - (safe.y + (safe.h - view.h) / 2)) <= 0.5 / c.dpr + 1e-9, `${tag}: centred down`);
    } else {
      band++;
      assert.ok(Math.abs(view.y - safe.y) <= 0.5 / c.dpr + 1e-9, `${tag}: the top at the safe top`);
      assert.ok(Math.abs(lay.band.y - (view.y + view.h)) < 1e-9, `${tag}: the band starts at the view's bottom`);
      assert.ok(Math.abs(lay.band.y + lay.band.h - (safe.y + safe.h)) < 1e-9, `${tag}: the band ends at the safe bottom`);
      assert.equal(lay.band.x, safe.x);
      assert.equal(lay.band.w, safe.w);
    }
    assert.ok(view.x >= safe.x - 1e-9 && view.x + view.w <= safe.x + safe.w + 1e-9, `${tag}: inside the safe width`);
  }
  assert.ok(overlay >= 4 && band >= 3, `${overlay} overlay and ${band} band layouts`);
});

test('a whole band is taller by the height the view gave up', () => {
  // The iPad: the fractional view is 774 CSS px tall and the whole one 720, so the band gains 54.
  const lay = layout(specOf(CASES[0]));
  assert.equal(lay.view.h, 720);
  assert.equal(lay.band.h, 1032 - 720);
  assert.equal(lay.mode, 'band');
});

test('a whole layout keeps the pad, the fire button and every soft key inside the safe area, and below the view in band mode', () => {
  let keys = 0;
  for (const spec of laidOut().filter(({ k }) => k >= 6).flatMap(({ c }) => [specOf(c), specOf(c, true)])) {
    const lay = layout(spec), tag = `${spec.w}x${spec.h} dpr ${spec.dpr} ${lay.mode}`;
    assert.ok(inside(sq(lay.pad), lay.safe) && inside(sq(lay.fire), lay.safe), `${tag}: pad and fire in the safe area`);
    if (lay.mode === 'band') assert.ok(lay.pad.y >= lay.view.y + lay.view.h - 1e-9 && lay.fire.y >= lay.view.y + lay.view.h - 1e-9, `${tag}: pad and fire below the view`);
    for (const sid of ['title', 'typing', 'confirm', 'pause', 'over', 'splash', 'play']) {
      const state = { screen: sid === 'typing' || sid === 'confirm' ? 'title' : sid, typing: sid === 'typing', confirm: sid === 'confirm', resume: true, difficulty: 'medium' };
      for (const r of keyRects(lay, sid, softKeys(state).map((k) => k.text))) {
        keys++;
        assert.ok(inside(r, lay.safe), `${tag} ${sid}: key in the safe area`);
        if (lay.mode === 'band') assert.ok(r.y >= lay.view.y + lay.view.h - 1e-9, `${tag} ${sid}: key below the view`);
      }
    }
  }
  assert.ok(keys > 300, `${keys} keys`);
});

test('every layout below 6x keeps the fractional fit of its limiting dimension', () => {
  let fallback = 0;
  for (const { c, lay, k } of laidOut()) {
    if (k >= 6) continue;
    fallback++;
    const dim = lay.mode === 'band' || lay.safe.w / 320 <= lay.safe.h / 180 ? 'w' : 'h';
    assert.ok(Math.abs(lay.backing[dim] - lay.safe[dim] * c.dpr) <= 1, `${c.tag}: fills the ${dim} within a device pixel`);
    assert.equal(lay.backing.w, Math.round(lay.view.w * c.dpr), c.tag);
  }
  assert.ok(fallback >= 6, `${fallback} fallback layouts`);
  assert.deepEqual(layout({ w: 300, h: 150, dpr: 1, insets: {}, touch: true }).backing, { w: 267, h: 150 });
  assert.deepEqual(layout(specOf(CASES[6])).backing, { w: 1179, h: 663 });
  assert.deepEqual(layout(specOf(CASES[7])).backing, { w: 1320, h: 743 });
});

test('the pad maps the centre to a dead zone and the dominant axis to an arm', () => {
  const D = 120;
  assert.equal(padZone(0, 0, D), 'c');
  assert.equal(padZone(19, 0, D), 'c');
  assert.equal(padZone(21, 0, D), 'r');
  assert.equal(padZone(-30, 10, D), 'l');
  assert.equal(padZone(10, -30, D), 'u');
  assert.equal(padZone(-10, 30, D), 'd');
  assert.equal(padZone(30, 30, D), 'r');
  assert.equal(padZone(-30, -30, D), 'l');
  assert.equal(padZone(-30, 30, D), 'l');
  assert.equal(padZone(500, -2000, D), 'u');
  assert.equal(padZone(-900, 100, D), 'l');
});

const codes = (ops) => ops.map((o) => `${o.type}:${o.code}`);

test('a pointer sliding across the pad swaps the held arrow and never jumps', () => {
  const p = createPad(), D = 120;
  assert.deepEqual(codes(p.down(1, 40, 0, D)), ['keydown:ArrowRight']);
  assert.deepEqual(codes(p.move(1, 41, 3, D)), []);
  assert.deepEqual(codes(p.move(1, 0, -40, D)), ['keyup:ArrowRight', 'keydown:ArrowUp']);
  assert.deepEqual(codes(p.move(1, 0, 0, D)), ['keyup:ArrowUp']);
  assert.deepEqual(codes(p.up(1)), []);
});

test('a pointer down in the centre sends nothing, and a slide through it never sends Space', () => {
  const p = createPad(), D = 120;
  assert.deepEqual(codes(p.down(1, 0, 0, D)), []);
  assert.deepEqual(codes(p.move(1, 40, 0, D)), ['keydown:ArrowRight']);
  assert.deepEqual(codes(p.move(1, 0, 0, D)), ['keyup:ArrowRight']);
  assert.deepEqual(codes(p.move(1, 0, -40, D)), ['keydown:ArrowUp']);
  assert.deepEqual(codes(p.up(1)), ['keyup:ArrowUp']);
  assert.deepEqual(codes(p.up(1)), []);
});

test('a direction stays down while any pointer holds it', () => {
  const p = createPad(), D = 120;
  assert.deepEqual(codes(p.down(1, 0, -40, D)), ['keydown:ArrowUp']);
  assert.deepEqual(codes(p.down(2, 5, -50, D)), []);
  assert.deepEqual(codes(p.up(1)), []);
  assert.deepEqual(codes(p.up(2)), ['keyup:ArrowUp']);
});

test('release lifts what a pointer holds, and a pointer off the pad keeps mapping by angle', () => {
  const p = createPad(), D = 120;
  p.down(1, -40, 0, D);
  p.down(2, 0, 40, D);
  assert.deepEqual(codes(p.move(1, -900, 30, D)), []);
  assert.deepEqual(codes(p.up(1)), ['keyup:ArrowLeft']);
  assert.deepEqual(codes(p.releaseAll()), ['keyup:ArrowDown']);
  assert.deepEqual([...p.held()], []);
  assert.deepEqual(codes(p.up(9)), []);
});

test('touch mode follows the last input type', () => {
  assert.equal(nextTouchMode(false, { type: 'pointerdown', pointerType: 'touch' }), true);
  assert.equal(nextTouchMode(false, { type: 'pointerdown', pointerType: 'mouse' }), false);
  assert.equal(nextTouchMode(true, { type: 'pointerdown', pointerType: 'mouse' }), true);
  assert.equal(nextTouchMode(true, { type: 'keydown', isTrusted: true }), false);
  assert.equal(nextTouchMode(true, { type: 'keydown', isTrusted: false }), true);
  assert.equal(nextTouchMode(false, { type: 'keydown', isTrusted: false }), false);
});

test('touch mode starts on a touch point, a coarse pointer or #touch', () => {
  assert.equal(touchAtBoot({}), false);
  assert.equal(touchAtBoot({ maxTouchPoints: 5 }), true);
  assert.equal(touchAtBoot({ coarse: true }), true);
  assert.equal(touchAtBoot({ hash: '#touch' }), true);
  assert.equal(touchAtBoot({ hash: '#selftest' }), false);
});

// A soft key whose code its screen's handler ignores fails silently, so each
// row is checked against the handler's source.
test('every soft key names a key its screen handler accepts', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const body = (name) => {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `${name} found`);
    return m[0];
  };
  const handler = { title: 'titleKey', typing: 'typingKey', confirm: 'confirmKey', play: 'playKey', pause: 'pauseKey', over: 'overKey', splash: 'splashKey' };
  for (const [sid, list] of Object.entries(SOFT)) {
    for (const k of list) {
      if (k.act === 'type') { assert.match(body('titleKey'), /'KeyT'/); continue; }
      const text = body(handler[sid]) + (k.code === 'KeyM' ? body('onKeyDown') : '');
      assert.ok(text.includes(`'${k.code}'`) || text.includes(`'${k.key}'`), `${sid}/${k.id} sends ${k.code}`);
    }
  }
});

test('the keys of one screen share a label scale', () => {
  const lay = layout(LANDSCAPE);
  const rects = keyRects(lay, 'title', ['RESUME', 'BEGIN', 'RESET', 'TYPE CODE', 'MEDIUM', 'COPY', 'SOUND']);
  assert.equal(new Set(rects.map((r) => r.scale)).size, 1);
});

test('PANEL_X matches the panels main.mjs draws', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const extent = (name) => {
    const fn = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(fn, `${name} found`);
    const p = fn[0].match(/r\.panel\((\d+), \d+, (\d+),/);
    assert.ok(p, `${name} draws a panel`);
    return [+p[1], +p[1] + +p[2]];
  };
  assert.deepEqual(PANEL_X.title, extent('drawTitle'));
  assert.deepEqual(PANEL_X.typing, extent('drawTitle'));
  assert.deepEqual(PANEL_X.confirm, extent('drawTitle'));
  assert.deepEqual(PANEL_X.pause, extent('drawPause'));
  assert.deepEqual(PANEL_X.over, extent('drawOver'));
  assert.deepEqual(PANEL_X.splash, extent('drawSplash'));
});

test('the title\'s typing line fits its panel at TYPED_MAX characters', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const max = Number(src.match(/const TYPED_MAX = (\d+);/)[1]);
  const line = src.match(/r\.text\(`([^`$]*)\$\{g\.typing\}\$\{[^}]*\}`, (\d+), \d+/);
  assert.ok(line, 'drawTitle draws the typing line');
  // The label, TYPED_MAX characters and the cursor.
  const end = Number(line[2]) + textWidth(`${line[1]}${'W'.repeat(max)}_`);
  // The title keeps 10 px inside its panel on both sides, as K COPY does at 248.
  assert.ok(end <= PANEL_X.typing[1] - 10, `the line ends at x ${end}`);
});

test('the title names the tomb\'s mouth when no best is stored', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const fn = src.match(/function drawTitle\([^)]*\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, 'drawTitle found');
  const line = fn[0].match(/r\.text\(best === null \? '([^']*)'/);
  assert.ok(line, 'drawTitle draws the best-tomb line');
  assert.equal(line[1], 'THE MOUTH OF THE TOMB');
  assert.ok(!fn[0].includes('NO TOMB REACHED YET'));
  const w = textWidth(line[1]), x0 = 160 - w / 2, x1 = 160 + w / 2;
  assert.ok(x0 >= PANEL_X.title[0] + 10, `the line starts at x ${x0}`);
  assert.ok(x1 <= PANEL_X.title[1] - 10, `the line ends at x ${x1}`);
});

test('the title\'s four level names lie right of L and inside the 248 text margin', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const fn = src.match(/function drawSettingRow\([^)]*\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, 'drawSettingRow found');
  let x = Number(fn[0].match(/let x = (\d+);/)[1]);
  assert.match(fn[0], /x \+= \(name\.length \+ 1\) \* 6;/);
  assert.deepEqual(DIFFICULTIES, ['easy', 'medium', 'hard', 'ultimate']);
  // Each name is the lit one at its own setting.
  for (const d of DIFFICULTIES) {
    const name = d.toUpperCase();
    assert.ok(x >= 84 && x + textWidth(name) <= 248, `${name} spans x ${x}..${x + textWidth(name)}`);
    x += (name.length + 1) * 6;
  }
});

test('soft keys follow the game state', () => {
  const ids = (st) => softKeys(st).map((k) => k.id);
  assert.deepEqual(ids({ screen: 'title', typing: false, resume: false }), ['begin', 'reset', 'type', 'difficulty', 'copy', 'sound', 'pad']);
  assert.deepEqual(ids({ screen: 'title', typing: false, resume: true }), ['resume', 'begin', 'reset', 'type', 'difficulty', 'copy', 'sound', 'pad']);
  assert.deepEqual(ids({ screen: 'title', typing: true, resume: true }), ['accept', 'cancel']);
  assert.deepEqual(ids({ screen: 'title', typing: false, confirm: true, resume: true }), ['yes', 'no']);
  assert.deepEqual(softKeys({ screen: 'title', confirm: true }).map((k) => [k.text, k.code, k.key]), [['YES', 'KeyY', 'y'], ['NO', 'KeyN', 'n']]);
  assert.deepEqual(ids({ screen: 'play' }), ['pause']);
  assert.deepEqual(ids({ screen: 'pause' }), ['resume', 'copy', 'sound', 'title']);
  assert.deepEqual(ids({ screen: 'over' }), ['continue', 'copy', 'title']);
  assert.deepEqual(ids({ screen: 'splash' }), ['continue', 'home']);
  assert.equal(softKeys({ screen: 'pause', muted: true }).find((k) => k.id === 'sound').text, 'MUTED');
  // The pad key reads the side in force.
  for (const [side, text] of [['left', 'PAD LEFT'], ['right', 'PAD RIGHT'], [undefined, 'PAD LEFT']]) {
    assert.equal(softKeys({ screen: 'title', side }).find((k) => k.id === 'pad').text, text);
  }
  // The difficulty key reads the setting, as SOUND reads mute.
  for (const d of ['easy', 'medium', 'hard', 'ultimate']) {
    const keys = softKeys({ screen: 'title', difficulty: d, muted: true });
    assert.equal(keys.find((k) => k.id === 'difficulty').text, d.toUpperCase());
    assert.equal(keys.find((k) => k.id === 'sound').text, 'MUTED');
  }
});

// Rectangles at least GAP apart on some axis.
const apart = (a, b) => a.x + a.w + GAP <= b.x + 1e-9 || b.x + b.w + GAP <= a.x + 1e-9 || a.y + a.h + GAP <= b.y + 1e-9 || b.y + b.h + GAP <= a.y + 1e-9;
const sq = (o) => ({ x: o.x, y: o.y, w: o.s, h: o.s });
const inside = (r, o) => r.x >= o.x - 1e-9 && r.y >= o.y - 1e-9 && r.x + r.w <= o.x + o.w + 1e-9 && r.y + r.h <= o.y + o.h + 1e-9;

test('soft keys are at least 44 px, in the safe area, and clear of the panel in overlay mode', () => {
  for (const spec of [PORTRAIT, LANDSCAPE, LAND_375, DESKTOP, SHORT, BIG, WIDE_320]) {
    const lay = layout(spec);
    for (const sid of ['title', 'typing', 'confirm', 'pause', 'over', 'splash', 'play']) {
      const state = { screen: sid === 'typing' || sid === 'confirm' ? 'title' : sid, typing: sid === 'typing', confirm: sid === 'confirm', resume: true, difficulty: 'medium' };
      const labels = softKeys(state).map((k) => k.text);
      const rects = keyRects(lay, sid, labels);
      assert.equal(rects.length, labels.length);
      if (sid === 'title') assert.equal(labels.length, 8, 'the title shows eight keys');
      if (spec === SHORT && sid === 'title') {
        assert.equal(lay.mode, 'overlay');
        assert.equal(new Set(rects.map((r) => r.x)).size, 2, '640x360: the title keys stand one column per strip');
        assert.deepEqual(rects.map((r) => r.x < lay.safe.x + lay.safe.w / 2), [true, true, true, true, false, false, false, false]);
        const sevenLabels = ['RESUME', 'BEGIN', 'RESET', 'TYPE CODE', 'MEDIUM', 'COPY', 'SOUND'];
        assert.equal(new Set(keyRects(lay, 'title', sevenLabels).map((r) => r.x)).size, 1, '640x360: seven keys keep one column');
      }
      assert.ok(new Set(rects.map((r) => r.scale)).size <= 1, `${lay.mode} ${sid}: one label scale`);
      rects.forEach((r, i) => assert.ok(textWidth(labels[i]) * r.scale + 8 <= r.w, `${lay.mode} ${sid}: ${labels[i]} fits its key`));
      for (const r of rects) {
        assert.ok(r.w >= 44 && r.h >= 44, `${lay.mode} ${sid} key size`);
        assert.ok(inside(r, lay.safe), `${lay.mode} ${sid} key in the safe area`);
        if (lay.mode === 'overlay' && sid !== 'play') {
          const [x0, x1] = PANEL_X[sid];
          const left = lay.view.x + x0 * lay.scale, right = lay.view.x + x1 * lay.scale;
          assert.ok(r.x + r.w <= left || r.x >= right, `${sid} key clear of the panel`);
        }
        if (lay.mode === 'band') assert.ok(r.y >= lay.view.y + lay.view.h, `${sid} key below the view`);
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'keys do not overlap');
        }
      }
      if (sid === 'play') {
        for (const r of rects) assert.ok(apart(r, sq(lay.pad)) && apart(r, sq(lay.fire)), 'play key clear of the pad and the fire button');
      }
    }
  }
});

test('in band mode the pad sits a quarter of the safe width in, never closer than the margin', () => {
  for (const spec of [PORTRAIT, IPAD, PHONE]) {
    const lay = layout(spec);
    const { pad, safe, view, D } = lay;
    const tag = `${spec.w}x${spec.h}`;
    assert.equal(lay.mode, 'band', `${tag} is band mode`);
    const want = safe.x + Math.max(MARGIN + D / 2, safe.w / 4);
    assert.ok(Math.abs(pad.x + pad.s / 2 - want) <= 1, `${tag}: pad centre at a quarter, clamped by the margin`);
    assert.ok(inside({ x: pad.x, y: pad.y, w: pad.s, h: pad.s }, safe), `${tag}: pad in the safe area`);
    assert.ok(pad.y >= view.y + view.h, `${tag}: pad below the view`);
    const labels = softKeys({ screen: 'play', typing: false, resume: false, difficulty: 'medium' }).map((k) => k.text);
    const rects = keyRects(lay, 'play', labels);
    assert.ok(rects.length > 0, `${tag}: play keys exist`);
    for (const r of rects) {
      assert.ok(apart(r, sq(pad)), `${tag}: play key clear of the pad`);
      assert.ok(inside(r, safe), `${tag}: play key in the safe area`);
    }
    if (spec === IPAD) {
      assert.ok(pad.x + pad.s / 2 <= safe.x + safe.w / 2 - safe.w / 5, 'iPad: pad centre well left of the band midpoint');
    }
    if (spec === PHONE) assert.equal(pad.x, safe.x + MARGIN, '320x568: the margin clamp binds');
  }
});

test('in band mode the pad centre sits halfway down the band, its top at least MARGIN below the view', () => {
  // BIG, IPAD_SHORT and DESKTOP have whole views, so their bands are the whole-view remainder.
  for (const spec of [PORTRAIT, IPAD, PHONE, BIG, IPAD_SHORT, DESKTOP]) {
    const { mode, pad, band } = layout(spec);
    assert.equal(mode, 'band', `${spec.w}x${spec.h} is band mode`);
    assert.ok(Math.abs(pad.y + pad.s / 2 - (band.y + band.h / 2)) <= 1e-9, `${spec.w}x${spec.h}: halfway down`);
  }
  assert.ok(Math.abs(layout(PORTRAIT).pad.y + 80 - (280 + 538 / 2)) <= 1e-9, 'the iPhone centre falls from 459.33 to 549');
  const lay = layout(SHORT_BAND), { pad, band, D } = lay;
  assert.equal(lay.mode, 'band');
  assert.equal(D, 160);
  assert.ok(Math.abs(pad.y - (band.y + MARGIN)) <= 1e-9, 'SHORT_BAND: the clamp binds');
  assert.ok(Math.abs(pad.y - (band.y + band.h / 2 - D / 2) - 1 / 6) <= 1e-9, 'SHORT_BAND: the clamp lifts the pad 1/6 px');
});

test('the fire button stands opposite the pad at its height, sized by FIRE_FRAC with a floor', () => {
  const half = (o) => o.x + o.s / 2;
  for (const spec of FIXTURES) {
    const tag = `${spec.w}x${spec.h}`;
    const lay = layout(spec), flipped = layout({ ...spec, swap: true });
    const c = lay.safe.x + lay.safe.w / 2;
    for (const l of [lay, flipped]) {
      assert.ok(Math.abs(half(l.fire) - (2 * c - half(l.pad))) <= 1e-9, `${tag}: fire mirrors the pad across the centre line`);
      assert.ok(Math.abs(l.fire.y + l.fire.s / 2 - (l.pad.y + l.pad.s / 2)) <= 1e-9, `${tag}: fire and pad share a centre y`);
      assert.equal(l.fire.s, Math.max(FIRE_MIN, Math.floor(FIRE_FRAC * l.D)), `${tag}: fire size`);
    }
    assert.ok(half(lay.pad) < c && half(flipped.pad) > c, `${tag}: the swap moves the pad to the right`);
    assert.ok(Math.abs(half(flipped.pad) - (2 * c - half(lay.pad))) <= 1e-9, `${tag}: the swapped pad is the default reflected`);
    assert.ok(Math.abs(half(flipped.fire) - (2 * c - half(lay.fire))) <= 1e-9, `${tag}: the swapped fire is the default reflected`);
    assert.equal(flipped.pad.y, lay.pad.y);
    assert.equal(flipped.pad.s, lay.pad.s);
    assert.equal(flipped.fire.s, lay.fire.s);
  }
  assert.equal(layout(PORTRAIT).fire.s, 64);
  assert.equal(layout({ w: 300, h: 300, dpr: 2, insets: {}, touch: true }).fire.s, 50);
  // D is 109 here, so FIRE_FRAC gives 43 and FIRE_MIN binds.
  assert.equal(layout({ w: 260, h: 260, dpr: 2, insets: {}, touch: true }).fire.s, FIRE_MIN);
  for (const swap of [false, true]) {
    const lay = layout({ w: 1280, h: 720, dpr: 2, touch: false, swap });
    assert.equal(lay.fire, null);
    assert.equal(lay.pad, null);
  }
});

test('padSide reads right only for the stored string right', () => {
  assert.equal(padSide('right'), 'right');
  for (const v of [null, undefined, '', 'RIGHT', 'left', 'x']) assert.equal(padSide(v), 'left');
});

test('PAUSE stands at the bottom centre at every fixture and on either side', () => {
  for (const spec of FIXTURES) {
    for (const swap of [false, true]) {
      const lay = layout({ ...spec, swap });
      const [r] = keyRects(lay, 'play', ['PAUSE']);
      const tag = `${spec.w}x${spec.h} swap ${swap}`;
      assert.ok(Math.abs(r.x + r.w / 2 - (lay.safe.x + lay.safe.w / 2)) <= 1, `${tag}: PAUSE centred`);
      assert.ok(Math.abs(r.y + r.h - (lay.safe.y + lay.safe.h - GAP)) <= 1e-9, `${tag}: PAUSE GAP above the safe bottom`);
      assert.equal(r.w, 96);
      assert.equal(r.h, 44);
    }
  }
});

// Every viewport from 300 to 1,400 CSS px in 2 px steps: 607,202 layouts per run.
test('the pad, the fire button and PAUSE stay GAP apart in the safe area at every viewport', () => {
  const started = performance.now();
  let count = 0;
  for (let w = 300; w <= 1400; w += 2) {
    for (let h = 300; h <= 1400; h += 2) {
      for (const swap of [false, true]) {
        const lay = layout({ w, h, dpr: 2, insets: {}, touch: true, swap });
        const [pause] = keyRects(lay, 'play', ['PAUSE']);
        const parts = [sq(lay.pad), sq(lay.fire), pause];
        count++;
        const ok = parts.every((r) => inside(r, lay.safe))
          && apart(parts[0], parts[1]) && apart(parts[0], parts[2]) && apart(parts[1], parts[2])
          && (lay.mode !== 'band' || parts.every((r) => r.y >= lay.view.y + lay.view.h - 1e-9));
        if (!ok) assert.fail(`${w}x${h} swap ${swap} ${lay.mode}: ${JSON.stringify(parts)}`);
      }
    }
  }
  assert.equal(count, 607202);
  console.log(`# sweep: ${count} layouts in ${Math.round(performance.now() - started)} ms`);
  // The fallback: PAUSE over the fire button where the bottom centre is too near a control.
  for (const [w, h, mode] of [[400, 420, 'band'], [400, 400, 'overlay']]) {
    const lay = layout({ w, h, dpr: 2, insets: {}, touch: true });
    const [pause] = keyRects(lay, 'play', ['PAUSE']);
    assert.equal(lay.mode, mode);
    assert.ok(Math.abs(pause.x + pause.w / 2 - (lay.fire.x + lay.fire.s / 2)) <= 1, `${w}x${h}: PAUSE centred on the fire button`);
    if (mode === 'band') assert.equal(pause.y, lay.band.y + GAP, `${w}x${h}: PAUSE at the top of the band`);
    if (w === 400 && h === 400) assert.ok(Math.abs(pause.y + pause.h + GAP - lay.fire.y) <= 1e-9, '400x400: PAUSE just above the fire button');
  }
});

// The 16x24 sprite box, in CSS px, of the preview explorer on the title.
const explorerBox = (lay) => {
  const [fx, fy] = titleFeet(lay), k = lay.scale;
  return { x: lay.view.x + (fx - 8) * k, y: lay.view.y + (fy - 24) * k, w: 16 * k, h: 24 * k };
};

// The title's keys with RESUME shown and hidden.
const titleLabels = (resume) => softKeys({ screen: 'title', typing: false, resume, difficulty: 'medium' }).map((k) => k.text);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const spec of [LANDSCAPE, LAND_375, SHORT, WIDE_320]) {
  test(`the title explorer stands clear of every title key at ${spec.w}x${spec.h}`, () => {
    const lay = layout(spec);
    assert.equal(lay.mode, 'overlay');
    assert.deepEqual(titleFeet(lay), [42, 176]);
    const box = explorerBox(lay);
    for (const resume of [true, false]) {
      const labels = titleLabels(resume);
      assert.equal(labels.length, resume ? 8 : 7);
      for (const r of keyRects(lay, 'title', labels)) assert.ok(apart(box, r), `RESUME ${resume}: explorer clear of ${JSON.stringify(r)}`);
    }
  });
}

test('the title explorer stands clear of every title key on the phones the owner plays', () => {
  const phones = [
    { w: 926, h: 428, dpr: 3 },
    { w: 956, h: 440, dpr: 3, insets: { left: 59, right: 59, bottom: 21 } },
    { w: 915, h: 412, dpr: 2.6 },
    { w: 841, h: 613, dpr: 2.6 },
    { w: 841, h: 583, dpr: 2.6 },
    { w: 667, h: 285, dpr: 2 },
    { w: 812, h: 285, dpr: 3, insets: { left: 50, right: 50 } },
  ];
  for (const p of phones) {
    const lay = layout({ insets: {}, ...p, touch: true });
    const tag = `${p.w}x${p.h} dpr ${p.dpr}`;
    assert.equal(lay.mode, 'overlay', tag);
    const box = explorerBox(lay);
    for (const resume of [true, false]) {
      for (const r of keyRects(lay, 'title', titleLabels(resume))) {
        assert.ok(apart(box, r), `${tag} RESUME ${resume}: explorer clear of ${JSON.stringify(r)}`);
      }
    }
  }
});

test('no title key meets the explorer at any viewport and ratio', () => {
  let overlay = 0;
  for (const dpr of [1, 2, 2.6, 3]) {
    for (let w = 300; w <= 1400; w += 2) {
      for (let h = 300; h <= 1400; h += 2) {
        const lay = layout({ w, h, dpr, insets: {}, touch: true });
        if (lay.mode !== 'overlay') continue;
        overlay++;
        const box = explorerBox(lay);
        for (const resume of [true, false]) {
          for (const r of keyRects(lay, 'title', titleLabels(resume))) {
            if (overlaps(box, r)) assert.fail(`${w}x${h} dpr ${dpr} RESUME ${resume}: ${JSON.stringify(r)} meets ${JSON.stringify(box)}`);
          }
        }
      }
    }
  }
  assert.ok(overlay > 0);
});

// Insets that leave the two strips one pixel apart after rounding: the keys share the narrower width.
for (const [dpr, wider] of [[2, 'left'], [3, 'right']]) {
  test(`title keys in two strips share the narrower width and stay in their strips, the ${wider} strip wider`, () => {
    const lay = layout({ w: 650, h: 340, dpr, insets: { left: 44 }, touch: true });
    const labels = softKeys({ screen: 'title', typing: false, resume: true }).map((k) => k.text);
    const rects = keyRects(lay, 'title', labels);
    const [p0, p1] = PANEL_X.title, { safe, view, scale } = lay;
    const left = { x: safe.x + GAP, w: view.x + p0 * scale - GAP - (safe.x + GAP) };
    const right = { x: view.x + p1 * scale + GAP, w: safe.x + safe.w - GAP - (view.x + p1 * scale + GAP) };
    assert.equal(Math.floor(left.w) > Math.floor(right.w), wider === 'left');
    const half = labels.length / 2;
    rects.forEach((r, i) => {
      const strip = i < half ? left : right;
      assert.equal(r.w, Math.floor(Math.min(left.w, right.w)), `${labels[i]} takes the narrower width`);
      assert.ok(r.x >= strip.x - 1e-9 && r.x + r.w <= strip.x + strip.w + 1e-9, `${labels[i]} stays in its strip`);
    });
  });
}

test('a touch starting within 350 ms of the last lift lifts quick, and a cancel forgets it', () => {
  const q = createQuickTaps();
  q.start(0, 1000);
  assert.equal(q.lift(0, 1100), false, 'the first tap has no lift before it');
  q.start(0, 1400);
  assert.equal(q.lift(0, 1500), true, 'a start 300 ms after a lift lifts quick');
  q.start(0, 1849);
  q.cancel(0);
  assert.equal(q.lift(0, 1900), false, 'a cancelled touch is no longer quick');
  q.start(0, 2249);
  assert.equal(q.lift(0, 2300), true, 'a start 349 ms after a lift is within the window');
  q.start(0, 2650);
  assert.equal(q.lift(0, 2700), false, 'a start 350 ms after a lift is outside it');
});

test('an id that started quick and never ended lifts as a plain tap once it starts outside the window', () => {
  const q = createQuickTaps();
  q.lift(5, 1000);
  q.start(1, 1100);
  // Android reuses id 1; the first touch never ended, then a slow tap takes it.
  q.start(1, 3000);
  assert.equal(q.lift(1, 3100), false);
  // The id still goes quick when it starts in a window again.
  q.start(1, 3200);
  assert.equal(q.lift(1, 3300), true);
});

test('the title explorer keeps its spot in band and keyboard modes', () => {
  assert.deepEqual(titleFeet(layout(PORTRAIT)), [42, 108]);
  assert.deepEqual(titleFeet(layout({ w: 1280, h: 720, dpr: 2, touch: false })), [42, 108]);
  assert.deepEqual(titleFeet(null), [42, 108]);
});

// The self-test's touch leg runs in Chrome. Set CHROME to its binary to run
// it here, and again with the touch layer removed, a control mis-keyed, the
// zoom guard dropped and each difficulty, pause-key, coin, recent-tomb, slot, continue-count, CONTINUE?, legacy-save, splash, oil, pad-side, fire and gamepad rule broken.
const chrome = process.env.CHROME;
const verdict = (html, window) => {
  const dir = mkdtempSync(join(tmpdir(), 'maze-touch-'));
  try {
    const file = join(dir, 'maze.html');
    writeFileSync(file, html);
    const out = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', `--window-size=${window}`, '--force-device-scale-factor=3',
      '--virtual-time-budget=30000', '--dump-dom', `file://${file}#selftest`,
    ], { encoding: 'utf8', timeout: 120000 });
    return (out.stdout.match(/data-selftest="([^"]*)"/) || [])[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the self-test touch leg passes, and fails without the touch layer, with a mis-keyed control, without the zoom guard or with a difficulty, pause-key, coin, recent-tomb, slot, continue-count, CONTINUE?, legacy-save, splash, oil, pad-side, fire or gamepad rule broken',
  { skip: !(chrome && existsSync(chrome)) && 'set CHROME to a Chrome binary' }, () => {
    const html = build();
    for (const size of ['500,1000', '1000,500']) assert.equal(verdict(html, size), 'pass');
    const noTouch = html.replace('touch = createTouch({', 'touch = null; void ({');
    assert.equal(html.split('touch = createTouch({').length, 2);
    assert.match(verdict(noTouch, '500,1000'), /^fail: .*touch/);
    const miskeyed = html.replace("...K('KeyR', 'r')", "...K('KeyX', 'x')");
    assert.equal(html.split("...K('KeyR', 'r')").length, 2);
    assert.match(verdict(miskeyed, '500,1000'), /^fail: touch RESET/);
    const zoomable = html.replace('stopDoubleTapZoom();', '');
    assert.equal(html.split('stopDoubleTapZoom();').length, 2);
    assert.match(verdict(zoomable, '500,1000'), /^fail: touch a tap starting 300 ms after a lift/);
    // Each difficulty, pause-key, coin, splash, oil, pad-side, fire and gamepad rule broken in turn: [from, to, the leg's first miss].
    for (const [from, to, miss] of [
      ['  keepSetting(g, slot.level);\n', '  void slot;\n', /^fail: touch RESUME rebuilds the save at HARD/],
      ['Math.max(0, Math.min(DIFFICULTIES.length - 1, at + SETTING_STEP[e.code]))', '(at + SETTING_STEP[e.code] + 4) % 4', /^fail: touch ArrowRight steps the setting to ULTIMATE/],
      ["return difficulty === 'ultimate' ? code :", 'return true ? code :', /^fail: touch an EASY run records its best/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "e.key === 'Escape') { if (!e.repeat) resume(g); }", /^fail: touch pause, TITLE and RESUME return to the same run/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "(e.code === 'KeyP' && !e.repeat) || e.key === 'Escape') { resume(g); }", /^fail: touch the title ignores an auto-repeated Esc/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "e.code === 'KeyP' || (e.key === 'Escape' && !e.repeat)) { resume(g); }", /^fail: touch the title ignores an auto-repeated P/],
      ["if (e.code === 'KeyP' || e.key === 'Escape') {\n    g.screen = 'pause';", "if (e.key === 'Escape') {\n    g.screen = 'pause';", /^fail: touch PAUSE reaches pause/],
      ["if (e.code === 'KeyP' || e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }", "if (e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }", /^fail: touch RESUME returns to play/],
      ["storedDifficulty(KEY_DIFFICULTY, 'medium')", "storedDifficulty(KEY_DIFFICULTY, 'easy')", /^fail: touch a new player starts at MEDIUM/],
      ["    slotId: null, serial: '', wallet: 0, tombs: new Map(), paid: new Map(),\n", "    slotId: null, serial: '', wallet: (readSlot() || { wallet: 0 }).wallet, tombs: new Map(), paid: new Map(),\n", /^fail: touch boot starts clean/],
      ['function beginClean(g) {\n  cleanState(g);\n', 'function beginClean(g) {\n', /^fail: touch BEGIN after a restored run starts with no coins/],
      ['  if (g.slotId === null) return;\n  g.serial = text;', '  g.serial = text;', /^fail: touch the slot outlives N until a new run earns/],
      ["    cleanState(g);\n    if (save.code !== g.code) useCode(g, save.code);\n    beginSaved(g, save.p, null);", "    if (save.code !== g.code) useCode(g, save.code);\n    beginSaved(g, save.p, null);", /^fail: touch a typed serial other than the slot's starts clean/],
      ['    cleanState(g);\n    useCode(g, g.code);\n  }\n}', '    useCode(g, g.code);\n  }\n}', /^fail: touch N returns to the title with no coins after a played run/],
      ["else if (e.code === 'KeyR') { cleanState(g); useCode(g, rollCode());", "else if (e.code === 'KeyR') { useCode(g, rollCode());", /^fail: touch RESET starts clean/],
      ['if (c) { cleanState(g); useCode(g, c);', 'if (c) { useCode(g, c);', /^fail: touch a typed seed starts clean/],
      ['    const { slot } = g.confirm;\n', '    const slot = readSlot();\n', /^fail: touch Y restores the snapshot CONTINUE\? showed/],
      ['wallet: slot.wallet,\n    tombs: new Map([[key, new Set(slot.tombs)]]), paid: new Map([[key, slot.record]]),', 'wallet: 0,\n    tombs: new Map(), paid: new Map(),', /^fail: touch Y restores the snapshot CONTINUE\? showed/],
      ["start: named ? run.start : `${tomb.u},${tomb.v}`,", "start: named ? run.start : '0,0',", /^fail: touch a legacy save without a run resumes at its own tomb/],
      ['  for (const old of Object.values(LEGACY_KEYS)) io.remove(old);\n', '', /^fail: touch a legacy save adopts the device wallet once/],
      ["difficulty: 'infinite-maze.plane.save.difficulty',", "difficulty: 'infinite-maze.save.difficulty',", /^fail: touch a legacy save with no stored difficulty adopts at ULTIMATE/],
      ["Object.hasOwn(COIN_RATE, d) ? d : 'ultimate'", "Object.hasOwn(COIN_RATE, d) ? d : 'hard'", /^fail: touch a legacy save with no stored difficulty adopts at ULTIMATE/],
      ['run.save === text && ', '', /^fail: touch a legacy run naming another save resumes at TOMB 0/],
      ['const same = held !== null && held.id === state.id;', 'const same = held !== null && held.save.slice(0, 9) === state.save.slice(0, 9) && held.level === state.level;', /^fail: touch a new tomb pays under the record at HARD/],
      ['  if (slot) g.confirm = { slot };\n', '  if (slot) restore(g, slot);\n', /^fail: touch RESUME with no open run asks CONTINUE\?/],
      ['  if (o) {\n', '  if (o) {\n    g.confirm = { slot: readSlot() };\n    return;\n', /^fail: touch RESUME of an open run continues without asking/],
      ["if (e.code === 'KeyY' || e.key === 'Enter') {", "if (e.code === 'KeyY' || e.code === 'KeyN' || e.key === 'Enter') {", /^fail: touch N returns to the title with no coins/],
      ['function confirmKey(g, e) {\n  if (e.repeat) return;\n', 'function confirmKey(g, e) {\n', /^fail: touch CONTINUE\? ignores a repeated key/],
      ['if (coins.length) collectCoin(g, coins);', 'if (false) collectCoin(g, coins);', /^fail: touch touching the first coin adds one to the wallet/],
      ['const COIN_RATE = { easy: 1, medium: 2, hard: 5, ultimate: 10 };', 'const COIN_RATE = { easy: 1, medium: 2, hard: 1, ultimate: 10 };', /^fail: touch a tomb solved first on this device pays 5 at HARD/],
      ['      if (!tombs.has(id)) {', '      if (true) {', /^fail: touch a replay of a solved tomb pays nothing at EASY/],
      ['      if (!tombs.has(id)) {', '      if (!tombs.has(id) && count > record) {', /^fail: touch a new tomb pays under the record at EASY/],
      ['const MAP_FRAME = Object.values(DIFFICULTY).map(mapCells)\n  .reduce((m, c) => ({ cols: Math.max(m.cols, c.cols), rows: Math.max(m.rows, c.rows) }));', 'const MAP_FRAME = mapCells(DIFFICULTY.hard);', /^fail: touch the pause map centres in ULTIMATE's 72x28-cell frame/],
      ['begin(g, s.lastEntry, { ...runCarry(s), continues: s.continues + 1 });', 'g.earned = 0; begin(g, s.lastEntry, { ...runCarry(s), continues: s.continues + 1 });', /^fail: touch CONTINUE keeps the coins earned this run/],
      ['    g.pausedAt = null;\n    writeSave(g, hereCode(g));', '    writeSave(g, hereCode(g));', /^fail: touch a second pause restarts the pause map clock/],
      ["} else if (e.code === 'KeyQ' || e.key === 'Escape') { g.screen = 'title'; g.copied = ''; titleCam(g); }", "} else if (e.code === 'KeyQ' || e.code === 'KeyP' || e.key === 'Escape') { g.screen = 'title'; g.copied = ''; titleCam(g); }", /^fail: touch P on the end screen leaves it showing/],
      ['      draw(g, now / 1000);', "      draw(g, now / 1000); throw new Error('frame');", /^fail: .*frame/],
      ['else if (hit) showSplash(g, hit.k, hit.paid);', 'else if (false) showSplash(g, hit.k, hit.paid);', /^fail: touch tomb 100 shows the splash with TORCHBEARER at EASY/],
      ['else if (hit) showSplash(g, hit.k, hit.paid);', 'if (hit) showSplash(g, hit.k, hit.paid);', /^fail: touch a run that ends on the crossing of tomb 100 shows the end screen/],
      ['  g.splash = { k, paid };\n  writeSave(g, hereCode(g));', '  g.splash = { k, paid };', /^fail: touch the EASY splash stores the save/],
      ['return last >= first ? (MILESTONE * (first + last) * (last - first + 1)) / 2 : 0;', 'return 0;', /^fail: touch tomb 100 pays 1 plus 100 at EASY/],
      ['function splashKey(g, e) {\n  if (e.repeat) return;\n', 'function splashKey(g, e) {\n', /^fail: touch a repeated Enter leaves the splash showing/],
      ["if (e.key === 'Enter') {\n    g.splash = null;", "if (e.key === 'Enter' || e.code === 'KeyP') {\n    g.splash = null;", /^fail: touch P leaves the splash showing/],
      ['const first = Math.floor(record / MILESTONE) + 1;', 'const first = last;', /^fail: touch a second crossing of tomb 100 pays nothing/],
      ['g.splash = null;\n    leaveOpen(g);', "g.splash = null;\n    g.screen = 'title';\n    titleCam(g);", /^fail: touch Q reaches the title with the run open/],
      ["if (kind !== 'oil') continue;", 'continue;', /^fail: touch touching the first oil jar at 100 s adds 60 s/],
      ['s.burn = Math.min(BURN_S, s.burn + JAR_S);', 's.burn += JAR_S;', /^fail: touch touching the second oil jar at 280 s caps the burn at full/],
      ['side: padSide(load(KEY_PAD)),', 'side: padSide(null),', /^fail: touch boot reads the stored pad side/],
      ['store(KEY_PAD, g.side);', 'void g;', /^fail: touch PAD stores the side and mirrors the layout/],
      ['tap(SPACE.code, SPACE.key);', "tap('KeyX', 'x');", /^fail: touch FIRE jumps/],
      ["if (!e.repeat) {\n      g.side =", "if (true) {\n      g.side =", /^fail: touch the title ignores an auto-repeated H/],
      ['for (const o of gamepad.poll()) {', 'for (const o of []) {', /^fail: touch gamepad d-pad left holds Left/],
      ['  if (same) {\n    state.wallet = Math.max(state.wallet, was.wallet);\n    for (const id of was.tombs) state.tombs.add(id);\n    state.record = Math.max(state.record, was.record);\n    state.continues = Math.max(state.continues, was.continues);\n  }\n', '', /^fail: touch two games on one slot keep both coins/],
      ['beginSaved(g, at.p, { solved: new Set(slot.solved), start: { u, v }, continues: slot.continues, ...unpackRecent(g.world, slot.recent) });', 'beginSaved(g, at.p, { ...unpackRecent(g.world, slot.recent) });', /^fail: touch RESUME after a reload continues at TOMB/],
      // A new run takes every coin back: the mutation hands the outgoing sim's taken set to the sim it creates.
      ['g.sim = createSim(g.world, start, carry);', 'g.sim = createSim(g.world, start, carry, { collected: g.sim ? g.sim.collected : undefined });', /^fail: touch BEGIN lays the coin back/],
      // The recent tombs: a tomb that leaves them keeps its takes; the slot drops them; a restore ignores them;
      // a change of tomb and a jar take skip the slot write.
      ['    forget(s, s.collected, key);\n    forget(s, s.jars, key);\n', '', /^fail: touch a coin two tombs back lies back/],
      ['tombs: [...slot.tombs], record, continues, recent,', 'tombs: [...slot.tombs], record, continues,', /^fail: touch RESUME after a reload keeps the coin taken/],
      ['beginSaved(g, at.p, { solved: new Set(slot.solved), start: { u, v }, continues: slot.continues, ...unpackRecent(g.world, slot.recent) });', 'beginSaved(g, at.p, { solved: new Set(slot.solved), start: { u, v }, continues: slot.continues });', /^fail: touch RESUME after a reload keeps the coin taken/],
      ['s.recent[0] !== lead || ', '', /^fail: touch a walk back into the previous tomb writes the slot's recent tombs/],
      [' || s.jars.size > jars', '', /^fail: touch a reload keeps a jar taken since the last tomb entry/],
      // Only a death raises the continue count: Continue carries it unchanged, and the slot's write from a dead run drops its plus one.
      ['begin(g, s.lastEntry, { ...runCarry(s), continues: s.continues + 1 });', 'begin(g, s.lastEntry, runCarry(s));', /^fail: touch a death and CONTINUE raise the continue count to 1/],
      ["continues: state === 'over' ? continues + 1 : continues", 'continues', /^fail: touch a second death stores 2 in the slot while the end screen shows 1/],
      ['if (kept && kept.code === save.code && kept.p === save.p) {', 'if (kept) {', /^fail: touch another save code starts at TOMB 0/],
      ['const memory = SELFTEST ? new Map() : null;', 'const memory = null;', /^fail: touch the self-test leaves the real wallet untouched/],
    ]) {
      const broken = html.replace(from, to);
      assert.equal(html.split(from).length, 2, `${from} occurs once`);
      assert.match(verdict(broken, '500,1000'), miss, from);
    }
  });

test('the self-test plane leg fails when the renderer refuses board columns outside the tomb at x 0 to W - 1',
  { skip: !(chrome && existsSync(chrome)) && 'set CHROME to a Chrome binary' }, () => {
    const html = build();
    const from = '  function boardArt(bx, by) {\n';
    assert.equal(html.split(from).length, 2);
    const guarded = html.replace(from, `${from}    if (bx < 0 || bx >= world.size.w) return null;\n`);
    assert.match(verdict(guarded, '1280,720'), /^fail: plane leg/);
  });
