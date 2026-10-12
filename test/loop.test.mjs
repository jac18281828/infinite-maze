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
  for (const work of ['pollGamepads()', 'tick(g)', 'draw(g, now / 1000)']) {
    assert.ok(body.indexOf(work) > guarded, `${work} runs inside the guard`);
  }
  assert.ok(!body.includes('requestAnimationFrame'), 'the guard requests the next frame');
});
