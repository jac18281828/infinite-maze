import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  layout, nextTouchMode, touchAtBoot, padZone, createPad, SOFT, softKeys, keyRects, MARGIN, PANEL_X, textWidth,
  FIRE_FRAC, FIRE_MIN, padSide, titleFeet,
} from '../src/game/touch.mjs';
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
  const lay = layout(LANDSCAPE);
  const { view, pad, safe } = lay;
  assert.equal(lay.mode, 'overlay');
  assert.ok(Math.abs(view.h - safe.h) < 1 / 3);
  assert.equal(pad.x, safe.x + MARGIN);
  assert.equal(pad.y + pad.s, safe.y + safe.h - MARGIN);
  assert.equal(pad.s, Math.floor(0.42 * safe.h));
});

test('touch mode fills the limiting dimension and the backing is the CSS size times the ratio', () => {
  for (const [spec, dim] of [[PORTRAIT, 'w'], [LANDSCAPE, 'h']]) {
    const lay = layout(spec);
    const dpr = spec.dpr;
    assert.ok(Math.abs(lay.backing[dim] - lay.safe[dim] * dpr) <= 1, `${dim} fills within a device pixel`);
    assert.equal(lay.backing.w, Math.round(lay.view.w * dpr));
    assert.equal(lay.backing.h, Math.round(lay.view.h * dpr));
    assert.ok(lay.view.x >= lay.safe.x - 1e-9 && lay.view.x + lay.view.w <= lay.safe.x + lay.safe.w + 1e-9);
    assert.ok(lay.view.y >= lay.safe.y - 1e-9 && lay.view.y + lay.view.h <= lay.safe.y + lay.safe.h + 1e-9);
  }
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
  const handler = { title: 'titleKey', typing: 'typingKey', play: 'playKey', pause: 'pauseKey', over: 'overKey', splash: 'splashKey' };
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
    for (const sid of ['title', 'typing', 'pause', 'over', 'splash', 'play']) {
      const state = { screen: sid === 'typing' ? 'title' : sid, typing: sid === 'typing', resume: true, difficulty: 'medium' };
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

test('in band mode the pad centre sits a quarter of the way down the band, its top at least MARGIN below the view', () => {
  for (const spec of [PORTRAIT, IPAD, PHONE]) {
    const { pad, band } = layout(spec);
    assert.ok(Math.abs(pad.y + pad.s / 2 - (band.y + band.h / 4)) <= 1, `${spec.w}x${spec.h}: a quarter down`);
  }
  assert.ok(Math.abs(layout(PORTRAIT).pad.y + 80 - 414.5) <= 1e-9, 'the iPhone centre rises from 549 to 414.5');
  for (const spec of [BIG, DESKTOP]) {
    const lay = layout(spec);
    assert.equal(lay.mode, 'band');
    assert.ok(Math.abs(lay.pad.y - (lay.band.y + MARGIN)) <= 1e-9, `${spec.w}x${spec.h}: the clamp binds`);
  }
  const { pad, band } = layout(BIG), centre = pad.y + pad.s / 2;
  for (const f of [1 / 4, 1 / 3, 1 / 2]) assert.ok(Math.abs(centre - (band.y + band.h * f)) > 1, `1366x1024: not ${f} of the band`);
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

for (const spec of [LANDSCAPE, LAND_375, SHORT, WIDE_320]) {
  test(`the title explorer stands clear of every title key at ${spec.w}x${spec.h}`, () => {
    const lay = layout(spec);
    assert.equal(lay.mode, 'overlay');
    assert.deepEqual(titleFeet(lay), [42, 176]);
    const labels = softKeys({ screen: 'title', typing: false, resume: true }).map((k) => k.text);
    assert.equal(labels.length, 8);
    const box = explorerBox(lay);
    for (const r of keyRects(lay, 'title', labels)) assert.ok(apart(box, r), `explorer clear of ${JSON.stringify(r)}`);
  });
}

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

test('the title explorer keeps its spot in band and keyboard modes', () => {
  assert.deepEqual(titleFeet(layout(PORTRAIT)), [42, 108]);
  assert.deepEqual(titleFeet(layout({ w: 1280, h: 720, dpr: 2, touch: false })), [42, 108]);
  assert.deepEqual(titleFeet(null), [42, 108]);
});

// The self-test's touch leg runs in Chrome. Set CHROME to its binary to run
// it here, and again with the touch layer removed, a control mis-keyed, the
// zoom guard dropped and each difficulty, pause-key, coin, splash, oil, pad-side, fire and gamepad rule broken.
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

test('the self-test touch leg passes, and fails without the touch layer, with a mis-keyed control, without the zoom guard or with a difficulty, pause-key, coin, splash, oil, pad-side, fire or gamepad rule broken',
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
      ['  if (o) {\n', '  if (false) {\n', /^fail: touch pause, TITLE and RESUME return to the same run/],
      ["storedDifficulty(KEY_SAVE_DIFFICULTY, 'ultimate')", "storedDifficulty(KEY_DIFFICULTY, 'medium')", /^fail: touch RESUME rebuilds the save at HARD/],
      ['Math.max(0, Math.min(DIFFICULTIES.length - 1, at + SETTING_STEP[e.code]))', '(at + SETTING_STEP[e.code] + 4) % 4', /^fail: touch ArrowRight steps the setting to ULTIMATE/],
      ["return difficulty === 'ultimate' ? code :", 'return true ? code :', /^fail: touch an EASY run records its best/],
      ["storedDifficulty(KEY_SAVE_DIFFICULTY, 'ultimate')", "storedDifficulty(KEY_SAVE_DIFFICULTY, 'hard')", /^fail: touch RESUME plays a save with no stored difficulty at ULTIMATE/],
      ["const KEY_SAVE_DIFFICULTY = 'infinite-maze.plane.save.difficulty';", "const KEY_SAVE_DIFFICULTY = 'infinite-maze.save.difficulty';", /^fail: touch RESUME plays a save with no stored difficulty at ULTIMATE/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "e.key === 'Escape') { if (!e.repeat) resume(g); }", /^fail: touch pause, TITLE and RESUME return to the same run/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "(e.code === 'KeyP' && !e.repeat) || e.key === 'Escape') { resume(g); }", /^fail: touch the title ignores an auto-repeated Esc/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "e.code === 'KeyP' || (e.key === 'Escape' && !e.repeat)) { resume(g); }", /^fail: touch the title ignores an auto-repeated P/],
      ["if (e.code === 'KeyP' || e.key === 'Escape') {\n    g.screen = 'pause';", "if (e.key === 'Escape') {\n    g.screen = 'pause';", /^fail: touch PAUSE reaches pause and stores a save/],
      ["if (e.code === 'KeyP' || e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }", "if (e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }", /^fail: touch RESUME returns to play/],
      ["storedDifficulty(KEY_DIFFICULTY, 'medium')", "storedDifficulty(KEY_DIFFICULTY, 'easy')", /^fail: touch a new player starts at MEDIUM/],
      ['function readCoinState() {\n', 'function readCoinState() {\n  return { wallet: 0, coins: new Map(), tombs: new Map(), paid: new Map() };\n', /^fail: touch boot reads the wallet and the collected set/],
      ['if (taken.length) collectCoin(g, taken);', 'if (false) collectCoin(g, taken);', /^fail: touch touching the first coin adds one to the wallet/],
      ['const COIN_RATE = { easy: 1, medium: 2, hard: 5, ultimate: 10 };', 'const COIN_RATE = { easy: 1, medium: 2, hard: 1, ultimate: 10 };', /^fail: touch a tomb solved first on this device pays 5 at HARD/],
      ['      if (!paid.has(id)) {', '      if (true) {', /^fail: touch a replay of a solved tomb pays nothing at EASY/],
      ['      if (!paid.has(id)) {', '      if (!paid.has(id) && count > record) {', /^fail: touch a new tomb pays under the record at EASY/],
      ['const MAP_FRAME = Object.values(DIFFICULTY).map(mapCells)\n  .reduce((m, c) => ({ cols: Math.max(m.cols, c.cols), rows: Math.max(m.rows, c.rows) }));', 'const MAP_FRAME = mapCells(DIFFICULTY.hard);', /^fail: touch the pause map centres in ULTIMATE's 72x28-cell frame/],
      ['begin(g, s.lastEntry, runCarry(s));', 'g.earned = 0; begin(g, s.lastEntry, runCarry(s));', /^fail: touch CONTINUE keeps the coins earned this run/],
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
      ['  state.wallet = Math.max(state.wallet, stored.wallet);\n  unionInto(state.coins, stored.coins);\n  unionInto(state.tombs, stored.tombs);\n  for (const [key, n] of stored.paid) state.paid.set(key, Math.max(state.paid.get(key) || 0, n));\n', '', /^fail: touch two games on one storage keep both coins/],
      ['beginSaved(g, s.p, storedRun());', 'beginSaved(g, s.p, null);', /^fail: touch RESUME after a reload continues at TOMB/],
      ['beginSaved(g, save.p, same ? storedRun() : null);', 'beginSaved(g, save.p, storedRun());', /^fail: touch another save code starts at TOMB 0/],
      ['  if (run.save !== load(KEY_SAVE)) return null;\n', '', /^fail: touch a stored run naming another save resumes at TOMB 0/],
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
