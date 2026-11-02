import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGuard, errorLine } from '../src/game/loop.mjs';

const STEP = 1 / 60;

// A guard over a fake request that counts the frames asked for.
function rig(over = {}) {
  const r = { requests: 0, logged: [], failed: 0, screen: 'play' };
  r.guard = createGuard({
    request: () => { r.requests++; },
    screen: () => r.screen,
    step: STEP,
    start: 0,
    log: (e) => r.logged.push(e),
    onFail: () => { r.failed++; },
    ...over,
  });
  // Runs a frame at `now` ms; `work` gets `due`.
  r.frame = (now, work) => r.guard.run(() => {}, now, work);
  return r;
}

const boom = () => { throw new Error('boom'); };

test('the next frame is requested whatever the frame does', () => {
  const r = rig();
  let ran = 0, now = 0;
  for (const work of [() => { ran++; }, boom, () => { ran++; }, boom, boom]) {
    assert.doesNotThrow(() => r.frame(now += 16, work));
  }
  assert.equal(r.requests, 5);
  assert.equal(ran, 2);
  assert.equal(r.failed, 3);
});

test('only the first failure reaches the log', () => {
  const r = rig();
  r.frame(16, boom);
  r.frame(32, () => {});
  r.frame(48, () => { throw new Error('again'); });
  assert.equal(r.logged.length, 1);
  assert.equal(r.logged[0].message, 'boom');
});

test('a failed frame leaves no tick backlog for the next', () => {
  const r = rig();
  let ticks = 0;
  // A stalled page: 5 s of wait caps at 0.25 s, 15 ticks, and the frame fails after one.
  r.frame(5000, (due) => {
    assert.ok(due());
    boom();
  });
  assert.equal(r.failed, 1);
  r.frame(5017, (due) => { while (due()) ticks++; });
  assert.equal(ticks, 1, 'one 17 ms frame owes one tick');
});

test('a good frame ticks by the time elapsed, capped at a quarter second', () => {
  const r = rig();
  const count = (now) => {
    let n = 0;
    r.frame(now, (due) => { while (due()) n++; });
    return n;
  };
  assert.equal(count(110), 6);
  assert.equal(count(5000), 15);
  assert.equal(count(5001), 0);
});

test('the line shows after a failure and through good frames until a key or a screen change', () => {
  const r = rig();
  assert.equal(r.guard.shown(), false);
  r.frame(16, boom);
  assert.equal(r.guard.shown(), true);
  r.frame(32, () => {});
  r.frame(48, () => {});
  assert.equal(r.guard.shown(), true, 'later good frames keep it');
  r.guard.release();
  assert.equal(r.guard.shown(), false, 'a key press releases it');

  r.frame(64, boom);
  assert.equal(r.guard.shown(), true);
  r.screen = 'pause';
  assert.equal(r.guard.shown(), false, 'a screen change releases it');
  r.screen = 'play';
  assert.equal(r.guard.shown(), false, 'and it stays released');

  r.screen = 'over';
  r.frame(80, boom);
  r.frame(96, () => {});
  assert.equal(r.guard.shown(), true, 'a failure that moved the screen holds on the new screen');
});

test('the ERROR line reads the save code, or the seed while the run has none', () => {
  assert.equal(errorLine('K7Q2-M9XA:13', 'ABCD-EFGH'), 'ERROR  SAVE CODE K7Q2-M9XA:13');
  assert.equal(errorLine('', 'ABCD-EFGH'), 'ERROR  SEED ABCD-EFGH');
});

test('runLoop runs its frame through the guard', () => {
  const src = readFileSync(new URL('../src/game/main.mjs', import.meta.url), 'utf8');
  const loop = src.match(/function runLoop\([^)]*\) \{[\s\S]*?\n\}\n/);
  assert.ok(loop, 'runLoop found');
  const frame = loop[0].slice(loop[0].indexOf('function frame(now) {'));
  const body = frame.slice(0, frame.indexOf('\n  }\n'));
  const guarded = body.indexOf('guard.run(frame, now,');
  assert.ok(guarded >= 0, 'frame calls guard.run');
  const at = (work) => body.indexOf(work);
  for (const work of ['meter.frame(now)', 'pollGamepads()', 'tick(g)', 'draw(g, now / 1000, guard.fraction())']) {
    assert.ok(at(work) > guarded, `${work} runs inside the guard`);
  }
  assert.ok(at('meter.frame(now)') < at('pollGamepads()'), 'the meter counts the frame first, before the gamepad poll');
  assert.ok(at('while (due()) tick(g)') < at('draw(g, now / 1000, guard.fraction())'), 'the frame draws at the fraction left after its ticks');
  assert.ok(!body.includes('requestAnimationFrame'), 'the guard requests the next frame');
});

test('fraction() is the tick fraction the accumulator holds after the frame\'s ticks', () => {
  const r = rig();
  const fraction = (now) => {
    let ticks = 0;
    r.frame(now, (due) => { while (due()) ticks++; });
    return [ticks, r.guard.fraction()];
  };
  assert.equal(r.guard.fraction(), 0, 'a fresh guard holds none');
  // 25 ms is one tick and a half; another 25 ms brings the total to 50 ms, three ticks.
  const [t1, a1] = fraction(25);
  assert.equal(t1, 1);
  assert.ok(Math.abs(a1 - 0.5) < 1e-9, `${a1} after 25 ms`);
  const [t2, a2] = fraction(50);
  assert.equal(t2, 2);
  assert.ok(a2 >= 0 && a2 < 1e-9, `${a2} after 50 ms`);
  // Every frame of a jittered 120 Hz clock leaves a fraction in [0, 1).
  let now = 50, seed = 7;
  for (let i = 0; i < 1000; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const [, a] = fraction(now += 1000 / 120 + (seed / 2147483648 - 0.5) * 4);
    assert.ok(a >= 0 && a < 1, `${a} at ${now} ms`);
  }
  // A failed frame leaves none.
  r.frame(now + 10, boom);
  assert.equal(r.guard.fraction(), 0);
});
