// The frame meter (spec section 9, Frame meter): its counter and boot rule in
// node, and its distance from the renderer.
import v8 from 'node:v8';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fps from '../src/game/fps.mjs';

const { createMeter, meterAtBoot, NO_READING } = fps;

/** A meter on, recording each reading and the frame time it came at. */
function meter() {
  const r = { readings: [], at: [], now: 0 };
  r.m = createMeter((text) => { r.readings.push(text); r.at.push(r.now); });
  r.frame = (now) => { r.now = now; r.m.frame(now); };
  return r;
}

// A fixed-seed LCG in [0, 1), so a jittered run reproduces.
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const RATES = [
  { name: '60 Hz', hz: 60, jitter: 0 },
  { name: '90 Hz', hz: 90, jitter: 0 },
  { name: '120 Hz', hz: 120, jitter: 0 },
  { name: '240 Hz', hz: 240, jitter: 0 },
  { name: '120 Hz with 2 ms of jitter', hz: 120, jitter: 2 },
];

/** Frame times at `rate` from `from` ms over `ms` ms, each moved by up to ±jitter ms. */
function times(rate, from, ms, seed = 11) {
  const next = rng(seed), out = [];
  for (let k = 0; (k * 1000) / rate.hz <= ms; k++) out.push(from + (k * 1000) / rate.hz + (k ? (next() * 2 - 1) * rate.jitter : 0));
  return out;
}

const counts = (readings) => readings.filter((r) => r !== NO_READING).map((r) => {
  assert.match(r, /^\d+ FPS$/);
  return Number.parseInt(r, 10);
});

for (const rate of RATES) {
  test(`(count) at ${rate.name} over 5 s, every reading after the first is the rate within 1`, (t) => {
    const r = meter();
    r.m.set(true);
    for (const now of times(rate, 0, 5000)) r.frame(now);
    const n = counts(r.readings);
    t.diagnostic(`readings ${n.join(', ')} FPS`);
    assert.equal(r.readings[0], NO_READING);
    assert.ok(n.length >= 4, `${n.length} readings`);
    for (const c of n.slice(1)) assert.ok(Math.abs(c - rate.hz) <= 1, `${c} FPS at ${rate.hz} Hz`);
  });

  test(`(once a second) at ${rate.name}, successive updates lie 1000 ms apart or more, one per second of frames`, () => {
    const r = meter();
    r.m.set(true);
    const ts = times(rate, 0, 5000);
    for (const now of ts) r.frame(now);
    const at = [ts[0], ...r.at.slice(1)];
    const period = 1000 / rate.hz + 2 * rate.jitter;
    for (let i = 1; i < at.length; i++) {
      const gap = at[i] - at[i - 1];
      assert.ok(gap >= 1000 && gap < 1000 + period, `update ${i} comes ${gap} ms after the last`);
    }
    // Each window spans 1000 ms and less than a frame more, so the updates number the seconds of frames.
    const span = ts[ts.length - 1] - ts[0], updates = at.length - 1;
    assert.ok(updates <= Math.floor(span / 1000) && updates >= Math.floor(span / (1000 + period)), `${updates} updates over ${span} ms`);
    if (!rate.jitter) assert.equal(updates, 5);
  });
}

test('(fresh start) turned on mid-run, it reads -- FPS for 1000 ms of frames, then counts only the frames since', () => {
  const r = meter();
  const rate = { hz: 120, jitter: 0 };
  // 2 s off, then on between two frames.
  for (const now of times(rate, 0, 2000)) r.frame(now);
  assert.deepEqual(r.readings, [], 'off, no frame reads');
  r.m.set(true);
  assert.deepEqual(r.readings, [NO_READING]);
  assert.equal(r.m.text, NO_READING);
  const on = times(rate, 2000 + 1000 / 240, 1500);
  for (const now of on.filter((x) => x - on[0] < 1000)) r.frame(now);
  assert.deepEqual(r.readings, [NO_READING], 'no update before 1000 ms of frames');
  for (const now of on.filter((x) => x - on[0] >= 1000)) r.frame(now);
  assert.deepEqual(r.readings, [NO_READING, '120 FPS'], 'the first update counts the frames since it turned on');
  // Off and on again: a fresh count, whatever the last one held.
  r.frame(on[on.length - 1] + 5);
  r.m.set(false);
  r.m.set(true);
  const again = times(rate, on[on.length - 1] + 400, 1000);
  for (const now of again) r.frame(now);
  assert.deepEqual(r.readings, [NO_READING, '120 FPS', null, NO_READING, '120 FPS']);
});

test('(fresh start) toggle turns it on and off, and a set to its own state shows nothing', () => {
  const r = meter();
  r.m.set(false);
  assert.deepEqual(r.readings, []);
  r.m.toggle();
  assert.equal(r.m.on, true);
  r.m.set(true);
  r.m.toggle();
  assert.equal(r.m.on, false);
  assert.equal(r.m.text, null);
  assert.deepEqual(r.readings, [NO_READING, null]);
});

const allocated = () => v8.getHeapStatistics().total_allocated_bytes;

/** The least bytes a call of `step` allocates over 3 windows of 100,000 calls, after a warm-up of as many, as in camera.test.mjs. */
function bytesPerCall(step) {
  for (let i = 0; i < 100000; i++) step();
  const per = [];
  for (let w = 0; w < 3; w++) {
    const before = allocated();
    for (let i = 0; i < 100000; i++) step();
    per.push((allocated() - before) / 100000);
  }
  return Math.min(...per);
}

test('(off) off, a frame yields no update, and a frame call off or on between updates allocates under 32 bytes', (t) => {
  const r = meter();
  for (const now of times({ hz: 120, jitter: 0 }, 0, 5000)) r.frame(now);
  assert.deepEqual(r.readings, [], 'off, no frame updates');
  // A typed clock: a double stored in a closure variable boxes on every call.
  const clock = new Float64Array(1);
  const off = createMeter(() => { throw new Error('off, the meter shows nothing'); });
  const offBytes = bytesPerCall(() => { off.frame(clock[0] += 16); });
  let shown = 0;
  const on = createMeter(() => { shown++; });
  on.set(true);
  clock[0] = 0;
  // 400,000 calls 1 µs apart span 400 ms: no update falls among them.
  const onBytes = bytesPerCall(() => { on.frame(clock[0] += 0.001); });
  assert.equal(shown, 1, 'only the turn-on reading');
  t.diagnostic(`off ${offBytes} bytes a call, on between updates ${onBytes}`);
  assert.ok(offBytes < 32, `off: ${offBytes} bytes a call`);
  assert.ok(onBytes < 32, `on between updates: ${onBytes} bytes a call`);
});

test('(boot) #fps turns it on at load; the empty hash, #touch, #selftest and #fpsx leave it off', () => {
  assert.equal(meterAtBoot('#fps'), true);
  for (const hash of ['', '#touch', '#selftest', '#fpsx', '#FPS', 'fps']) assert.equal(meterAtBoot(hash), false, hash);
});

test('(outside the renderer) render.mjs imports nothing from fps.mjs, and draw and hud name no meter symbol', () => {
  const render = readFileSync(new URL('../src/game/render.mjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  assert.ok(!/from '\.\/fps\.mjs'/.test(render), 'render.mjs imports fps.mjs');
  const draw = main.match(/\nfunction draw\([^)]*\) \{[\s\S]*?\n\}\n/);
  const hud = render.match(/\n {2}function hud\([^)]*\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(draw && hud, 'draw and hud found');
  for (const name of ['meter', 'showMeter', ...Object.keys(fps)]) {
    for (const [what, src] of [['draw', draw[0]], ['hud', hud[0]]]) assert.ok(!src.includes(name), `${what} names ${name}`);
  }
});
