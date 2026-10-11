import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  layout, nextTouchMode, touchAtBoot, padZone, createPad, SOFT, softKeys, keyRects, MARGIN, PANEL_X, textWidth,
} from '../src/game/touch.mjs';
import { build } from '../tools/build.mjs';

const PORTRAIT = { w: 393, h: 852, dpr: 3, insets: { top: 59, bottom: 34, left: 0, right: 0 }, touch: true };
const LANDSCAPE = { w: 852, h: 393, dpr: 3, insets: { top: 0, bottom: 21, left: 59, right: 59 }, touch: true };

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

test('the pad maps the centre to a jump and the dominant axis to an arm', () => {
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

test('a pointer down in the centre jumps, then an arm presses when the thumb rolls', () => {
  const p = createPad(), D = 120;
  assert.deepEqual(codes(p.down(1, 0, 0, D)), ['keydown:Space', 'keyup:Space']);
  assert.deepEqual(codes(p.move(1, 40, 0, D)), ['keydown:ArrowRight']);
  assert.deepEqual(codes(p.up(1)), ['keyup:ArrowRight']);
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
  const handler = { title: 'titleKey', typing: 'typingKey', play: 'playKey', pause: 'pauseKey', over: 'overKey' };
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
});

test('soft keys follow the game state', () => {
  const ids = (st) => softKeys(st).map((k) => k.id);
  assert.deepEqual(ids({ screen: 'title', typing: false, resume: false }), ['begin', 'reset', 'type', 'difficulty', 'copy', 'sound']);
  assert.deepEqual(ids({ screen: 'title', typing: false, resume: true }), ['resume', 'begin', 'reset', 'type', 'difficulty', 'copy', 'sound']);
  assert.deepEqual(ids({ screen: 'title', typing: true, resume: true }), ['accept', 'cancel']);
  assert.deepEqual(ids({ screen: 'play' }), ['pause']);
  assert.deepEqual(ids({ screen: 'pause' }), ['resume', 'copy', 'sound', 'title']);
  assert.deepEqual(ids({ screen: 'over' }), ['continue', 'copy', 'title']);
  assert.equal(softKeys({ screen: 'pause', muted: true }).find((k) => k.id === 'sound').text, 'MUTED');
  // The difficulty key reads the setting, as SOUND reads mute.
  for (const d of ['easy', 'medium', 'hard']) {
    const keys = softKeys({ screen: 'title', difficulty: d, muted: true });
    assert.equal(keys.find((k) => k.id === 'difficulty').text, d.toUpperCase());
    assert.equal(keys.find((k) => k.id === 'sound').text, 'MUTED');
  }
});

const inside = (r, o) => r.x >= o.x - 1e-9 && r.y >= o.y - 1e-9 && r.x + r.w <= o.x + o.w + 1e-9 && r.y + r.h <= o.y + o.h + 1e-9;

// A 360 px tall landscape phone: seven 44 px keys fit one column only at 6 px gaps.
const SHORT = { w: 640, h: 360, dpr: 2, insets: {}, touch: true };

test('soft keys are at least 44 px, in the safe area, and clear of the panel in overlay mode', () => {
  for (const spec of [PORTRAIT, LANDSCAPE, { ...LANDSCAPE, w: 667, h: 375, insets: {} }, { w: 1024, h: 768, dpr: 2, insets: {}, touch: true }, SHORT]) {
    const lay = layout(spec);
    for (const sid of ['title', 'typing', 'pause', 'over', 'play']) {
      const state = { screen: sid === 'typing' ? 'title' : sid, typing: sid === 'typing', resume: true, difficulty: 'medium' };
      const labels = softKeys(state).map((k) => k.text);
      const rects = keyRects(lay, sid, labels);
      assert.equal(rects.length, labels.length);
      if (sid === 'title') assert.equal(labels.length, 7, 'the title shows seven keys');
      if (spec === SHORT && sid === 'title') {
        assert.equal(lay.mode, 'overlay');
        assert.equal(new Set(rects.map((r) => r.x)).size, 1, '640x360: the title keys stand in one column');
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
      if (lay.mode === 'band' && sid === 'play') {
        for (const r of rects) assert.ok(r.x >= lay.pad.x + lay.pad.s || r.x + r.w <= lay.pad.x, 'play key clear of the pad');
      }
    }
  }
});

test('in band mode the pad sits a quarter of the safe width in, never closer than the margin', () => {
  const IPAD = { w: 820, h: 1180, dpr: 2, insets: {}, touch: true };
  const PHONE = { w: 320, h: 568, dpr: 2, insets: {}, touch: true };
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
      assert.ok(r.x >= pad.x + pad.s, `${tag}: play key right of the pad`);
      assert.ok(inside(r, safe), `${tag}: play key in the safe area`);
    }
    if (spec === IPAD) {
      assert.ok(pad.x + pad.s / 2 <= safe.x + safe.w / 2 - safe.w / 5, 'iPad: pad centre well left of the band midpoint');
    }
    if (spec === PHONE) assert.equal(pad.x, safe.x + MARGIN, '320x568: the margin clamp binds');
  }
});

// The self-test's touch leg runs in Chrome. Set CHROME to its binary to run
// it here, and again with the touch layer removed, a control mis-keyed, the
// zoom guard dropped and each difficulty and pause-key rule broken.
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

test('the self-test touch leg passes, and fails without the touch layer, with a mis-keyed control, without the zoom guard or with a difficulty or pause-key rule broken',
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
    // Each difficulty and pause-key rule broken in turn: [from, to, the leg's first miss].
    for (const [from, to, miss] of [
      ['  if (o) {\n', '  if (false) {\n', /^fail: touch pause, TITLE and RESUME return to the same run/],
      ["storedDifficulty(KEY_SAVE_DIFFICULTY, 'hard')", "storedDifficulty(KEY_DIFFICULTY, 'medium')", /^fail: touch RESUME rebuilds the save at HARD/],
      ['Math.max(0, Math.min(DIFFICULTIES.length - 1, at + SETTING_STEP[e.code]))', '(at + SETTING_STEP[e.code] + 3) % 3', /^fail: touch ArrowRight steps the setting to HARD/],
      ["return difficulty === 'hard' ? code :", 'return true ? code :', /^fail: touch an EASY run records its best/],
      ["storedDifficulty(KEY_SAVE_DIFFICULTY, 'hard')", "storedDifficulty(KEY_SAVE_DIFFICULTY, 'medium')", /^fail: touch RESUME plays a save with no stored difficulty at HARD/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "e.key === 'Escape') { if (!e.repeat) resume(g); }", /^fail: touch pause, TITLE and RESUME return to the same run/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "(e.code === 'KeyP' && !e.repeat) || e.key === 'Escape') { resume(g); }", /^fail: touch the title ignores an auto-repeated Esc/],
      ["e.code === 'KeyP' || e.key === 'Escape') { if (!e.repeat) resume(g); }", "e.code === 'KeyP' || (e.key === 'Escape' && !e.repeat)) { resume(g); }", /^fail: touch the title ignores an auto-repeated P/],
      ["if (e.code === 'KeyP' || e.key === 'Escape') {\n    g.screen = 'pause';", "if (e.key === 'Escape') {\n    g.screen = 'pause';", /^fail: touch PAUSE reaches pause and stores a save/],
      ["if (e.code === 'KeyP' || e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }", "if (e.key === 'Escape') { g.screen = 'play'; g.copied = ''; }", /^fail: touch RESUME returns to play/],
      ["storedDifficulty(KEY_DIFFICULTY, 'medium')", "storedDifficulty(KEY_DIFFICULTY, 'easy')", /^fail: touch a new player starts at MEDIUM/],
    ]) {
      const broken = html.replace(from, to);
      assert.equal(html.split(from).length, 2, `${from} occurs once`);
      assert.match(verdict(broken, '500,1000'), miss, from);
    }
  });

test('the self-test plane leg fails when the renderer refuses board columns outside 0-5',
  { skip: !(chrome && existsSync(chrome)) && 'set CHROME to a Chrome binary' }, () => {
    const html = build();
    const guarded = html.replace('  function boardArt(bx, by) {\n', '  function boardArt(bx, by) {\n    if (bx < 0 || bx >= 6) return null;\n');
    assert.notEqual(guarded, html);
    assert.match(verdict(guarded, '1280,720'), /^fail: plane leg/);
  });
